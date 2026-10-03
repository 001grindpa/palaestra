CONTRACT = "contracts/Palaestra.py"
URL_A = "https://www.bbc.com/sport"
URL_B = "https://www.reuters.com/sports/"


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
    direct_vm.sender = direct_alice
    wager_id = contract.create_wager(
        "Did team X win on 2026-10-03?",
        "2026-10-03",
        "2026-10-03",
        "NO",
        URL_A,
        URL_B,
        value=10**18,
    )
    direct_vm.sender = direct_bob
    contract.join(wager_id, value=10**18)
    raw = contract.get_wager(wager_id)
    assert "2026-10-03" in raw
    assert "2026-10-04" in raw
    with direct_vm.expect_revert("timeout_refund cannot run before refund_after"):
        contract.timeout_refund(wager_id)
    assert "MATCHED" in contract.get_wager(wager_id)


def test_timeout_refunds_both_once(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2020-01-01"
    )
    assert "2020-01-02" in contract.get_wager(wager_id)
    contract.timeout_refund(wager_id)
    after = contract.get_wager(wager_id)
    assert "REFUNDED" in after
    assert "TIMEOUT" in after
    assert "REFUNDED_TO_BOTH" in after
    assert contract.get_reserved_stakes() == "0"
    with direct_vm.expect_revert("only a matched wager can be timeout-refunded"):
        contract.timeout_refund(wager_id)


def test_unknown_does_not_pay(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = direct_deploy(CONTRACT)
    wager_id = _matched(
        contract, direct_vm, direct_alice, direct_bob, resolve_after="2020-01-01"
    )

    def unknown(_wager):
        return {"verdict": "UNKNOWN"}

    contract._adjudicate = unknown
    contract.resolve(wager_id)
    after = contract.get_wager(wager_id)
    assert "MATCHED" in after
    assert "UNKNOWN" in after
    assert "SETTLED" not in after
    assert "PAID_TO_WINNER" not in after