CONTRACT = "src/Hanaper.py"
REG = "https://www.gov.uk/government/publications"
GAZ = "https://www.thegazette.co.uk/"


def _post(contract, vm, operator, regulator="", resolve_after="2026-12-31"):
    vm.sender = operator
    return contract.post_bond(
        "MTL-4421 Lagos venue",
        "2026-09-30",
        resolve_after,
        REG,
        GAZ,
        regulator,
        value=10**18,
    )


def test_sources_must_differ(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("sources must come from two different hosts"):
        contract.post_bond(
            "MTL-4421 Lagos venue",
            "2026-09-30",
            "2026-12-31",
            REG,
            "https://www.gov.uk/licence-register",
            "",
            value=10**18,
        )


def test_regulator_cannot_be_operator(
    direct_vm, direct_deploy, direct_alice
):
    contract = direct_deploy(CONTRACT)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("regulator cannot be the operator"):
        contract.post_bond(
            "MTL-4421 Lagos venue",
            "2026-09-30",
            "2026-12-31",
            REG,
            GAZ,
            str(direct_alice),
            value=10**18,
        )


def test_early_resolve_blocked(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    bond_id = _post(contract, direct_vm, direct_alice)
    assert "POSTED" in contract.get_bond(bond_id)
    with direct_vm.expect_revert("bond cannot be closed before resolve_after"):
        contract.resolve(bond_id)
    with direct_vm.expect_revert("bond cannot be closed before resolve_after"):
        contract.timeout_unlock(bond_id)
    assert "POSTED" in contract.get_bond(bond_id)


def test_timeout_returns_bond_once(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    bond_id = _post(contract, direct_vm, direct_alice, resolve_after="2020-01-01")
    contract.timeout_unlock(bond_id)
    after = contract.get_bond(bond_id)
    assert "UNLOCKED" in after
    assert "TIMEOUT" in after
    assert "RETURNED_TO_OPERATOR" in after
    assert contract.get_reserved_bonds() == "0"
    with direct_vm.expect_revert("only a posted bond can be timeout-unlocked"):
        contract.timeout_unlock(bond_id)


def test_unknown_does_not_forfeit(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy(CONTRACT)
    bond_id = _post(contract, direct_vm, direct_alice, resolve_after="2020-01-01")

    def unknown(_bond):
        return {"verdict": "UNKNOWN"}

    contract._adjudicate = unknown
    contract.resolve(bond_id)
    after = contract.get_bond(bond_id)
    assert "POSTED" in after
    assert "UNKNOWN" in after
    assert "FORFEITED" not in after
    assert "RELEASED" not in after