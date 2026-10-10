CONTRACT = "src/Palaestra.py"
URL_A = "https://www.bbc.com/sport"
URL_B = "https://www.reuters.com/sports/"


def _set_today(day: str) -> None:
    import src.Palaestra as mod

    mod._today_utc = lambda: day


def _open(contract, vm, creator, resolve_after="2026-12-31"):
    vm.sender = creator
    return contract.create_wager(
        "Did team X win on 2026-12-31?",
        "2026-12-31",
        resolve_after,
        "YES",
        URL_A,
        URL_B,
        value=10**18,
    )


def _matched(contract, vm, creator, joiner, resolve_after="2026-12-31"):
    wager_id = _open(contract, vm, creator, resolve_after)
    vm.sender = joiner
    contract.join(wager_id, value=10**18)
    return wager_id


def test_creator_cannot_join(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    wager_id = _open(contract, direct_vm, direct_alice)
    with direct_vm.expect_revert("creator cannot join"):
        contract.join(wager_id, value=10**18)


def test_sources_must_differ(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("sources must come from two different hosts"):
        contract.create_wager(
            "Did team X win on 2026-12-31?",
            "2026-12-31",
            "2026-12-31",
            "YES",
            URL_A,
            "https://www.bbc.com/news",
            value=10**18,
        )


def test_rejects_impossible_date(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("event_date must be a real calendar date"):
        contract.create_wager(
            "Did team X win on 2026-12-31?",
            "2026-02-31",
            "2026-12-31",
            "YES",
            URL_A,
            URL_B,
            value=10**18,
        )


def test_join_stake_must_match(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    wager_id = _open(contract, direct_vm, direct_alice)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("join stake must match"):
        contract.join(wager_id, value=2 * 10**18)


def test_cancel_only_unmatched(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    wager_id = _matched(contract, direct_vm, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("matched wagers close via resolve or timeout_refund"):
        contract.cancel(wager_id)


def test_early_resolve_and_timeout_blocked(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy(CONTRACT)
    wager_id = _matched(contract, direct_vm, direct_alice, direct_bob)
    raw = contract.get_wager(wager_id)
    assert "MATCHED" in raw
    assert "2027-01-01" in raw

    with direct_vm.expect_revert("wager cannot be closed before resolve_after"):
        contract.resolve(wager_id)
    with direct_vm.expect_revert("timeout_refund cannot run before refund_after"):
        contract.timeout_refund(wager_id)

    after = contract.get_wager(wager_id)
    assert "MATCHED" in after
    assert "SETTLED" not in after
    assert "REFUNDED" not in after


def test_refund_not_open_when_resolve_first_opens(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy(CONTRACT)
    _set_today("2026-10-10")
    direct_vm.sender = direct_alice
    wager_id = contract.create_wager(
        "Did team X win on 2026-10-10?",
        "2026-10-10",
        "2026-10-10",
        "NO",
        URL_A,
        URL_B,
        value=10**18,
    )
    direct_vm.sender = direct_bob
    contract.join(wager_id, value=10**18)

    def unknown(_wager):
        return {"verdict": "UNKNOWN"}

    contract._adjudicate = unknown
    contract.resolve(wager_id)
    raw = contract.get_wager(wager_id)
    assert "2026-10-10" in raw
    assert "2026-10-11" in raw
    assert "UNKNOWN" in raw
    with direct_vm.expect_revert("timeout_refund cannot run before refund_after"):
        contract.timeout_refund(wager_id)
    assert "MATCHED" in contract.get_wager(wager_id)


def test_expired_unresolved_recovers_once(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy(CONTRACT)
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2020-01-01"
    )
    with direct_vm.expect_revert("resolve is closed"):
        contract.resolve(wager_id)
    contract.timeout_refund(wager_id)
    after = contract.get_wager(wager_id)
    assert "REFUNDED" in after
    assert "EXPIRED" in after
    assert "REFUNDED_TO_BOTH" in after
    assert contract.get_reserved_stakes() == "0"
    with direct_vm.expect_revert("only a matched wager can be timeout-refunded"):
        contract.timeout_refund(wager_id)
    with direct_vm.expect_revert("wager must be MATCHED to resolve"):
        contract.resolve(wager_id)


def test_resolve_closed_after_refund_deadline(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy(CONTRACT)
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2020-01-01"
    )
    with direct_vm.expect_revert("resolve is closed"):
        contract.resolve(wager_id)
    after = contract.get_wager(wager_id)
    assert "MATCHED" in after
    assert "SETTLED" not in after
    assert "REFUNDED" not in after


def test_yes_pays_creator_once(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    _set_today("2026-10-10")
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2026-10-10"
    )

    def yes(_wager):
        return {"verdict": "YES"}

    contract._adjudicate = yes
    contract.resolve(wager_id)
    after = contract.get_wager(wager_id)
    assert "SETTLED" in after
    assert "YES" in after
    assert "PAID_TO_WINNER" in after
    assert contract.get_reserved_stakes() == "0"
    with direct_vm.expect_revert("wager must be MATCHED to resolve"):
        contract.resolve(wager_id)
    with direct_vm.expect_revert("only a matched wager can be timeout-refunded"):
        contract.timeout_refund(wager_id)


def test_no_pays_joiner_once(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    _set_today("2026-10-10")
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2026-10-10"
    )

    def no(_wager):
        return {"verdict": "NO"}

    contract._adjudicate = no
    contract.resolve(wager_id)
    after = contract.get_wager(wager_id)
    assert "SETTLED" in after
    assert "NO" in after
    assert "PAID_TO_WINNER" in after
    assert contract.get_reserved_stakes() == "0"
    with direct_vm.expect_revert("only a matched wager can be timeout-refunded"):
        contract.timeout_refund(wager_id)


def test_resolve_then_timeout_refund_on_same_wager(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy(CONTRACT)
    _set_today("2026-10-10")
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2026-10-10"
    )

    def unknown(_wager):
        return {"verdict": "UNKNOWN"}

    contract._adjudicate = unknown
    contract.resolve(wager_id)
    assert "UNKNOWN" in contract.get_wager(wager_id)

    with direct_vm.expect_revert("timeout_refund cannot run before refund_after"):
        contract.timeout_refund(wager_id)

    _set_today("2026-10-11")
    contract.timeout_refund(wager_id)
    after = contract.get_wager(wager_id)
    assert "REFUNDED" in after
    assert "TIMEOUT" in after
    assert "REFUNDED_TO_BOTH" in after
    assert contract.get_reserved_stakes() == "0"

    with direct_vm.expect_revert("wager must be MATCHED to resolve"):
        contract.resolve(wager_id)
    with direct_vm.expect_revert("only a matched wager can be timeout-refunded"):
        contract.timeout_refund(wager_id)


def test_timeout_refund_then_resolve_on_same_wager(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy(CONTRACT)
    _set_today("2026-10-11")
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2026-10-10"
    )
    contract.timeout_refund(wager_id)
    after = contract.get_wager(wager_id)
    assert "REFUNDED" in after
    assert "EXPIRED" in after
    assert "REFUNDED_TO_BOTH" in after
    assert contract.get_reserved_stakes() == "0"
    with direct_vm.expect_revert("wager must be MATCHED to resolve"):
        contract.resolve(wager_id)
    with direct_vm.expect_revert("only a matched wager can be timeout-refunded"):
        contract.timeout_refund(wager_id)