# Hanaper

Hanaper is a Genlayer smart contract for posting a bond around a license or permit validity check. The bond is funded by the operator, then resolved against two independent public sources: a registry URL and a gazette/news-style URL.

Deployed contract address:
0xad08eDf5E327B3A1D65c685b0077e6472A3735a7

Deployed explorer:
https://explorer-studio.genlayer.com/address/0xad08eDf5E327B3A1D65c685b0077e6472A3735a7

## How the contract works

A user calls post_bond with:
- license_ref
- expiry_date
- resolve_after
- registry_url
- gazette_url
- regulator (optional)
- value (bond amount)

The contract validates the inputs before accepting the bond:
- license_ref must be long enough
- dates must be valid YYYY-MM-DD values
- resolve_after must be on or after expiry_date
- both URLs must use HTTPS
- both URLs must be on an allowlist of government and trusted public sources
- registry_url and gazette_url must come from different hosts
- regulator cannot be the same address as the operator
- bond value must be greater than zero

Once posted, the bond is stored in the contract and the value is marked as reserved.

When resolve is called after resolve_after, the contract evaluates both sources and compares their conclusions. It uses nondeterministic adjudication to decide whether the license remained valid, lapsed, or is inconclusive.

The verdict can be:
- VALID: funds are returned to the operator
- LAPSED: funds are paid to the regulator if set, otherwise to the challenger who triggered the resolution
- UNKNOWN or DISAGREE: the bond stays posted and no forfeiture occurs

The contract also supports timeout_unlock. After resolve_after, a posted bond may be returned to the operator as a timeout if it has not been resolved. This marks the bond as UNLOCKED and returns the reserved funds.

## Key storage and reads

The main public reads are:
- get_bond(bond_id): returns the bond record
- get_bond_count(): total number of bonds posted
- get_reserved_bonds(): total funds currently reserved
- can_resolve(bond_id): reports whether the bond is eligible for resolution at the current time

The bond record includes:
- operator
- regulator
- license_ref
- expiry_date
- resolve_after
- registry_url
- gazette_url
- amount
- reserved
- status
- verdict
- funds_disposition

## Current test coverage

The current tests in test/direct/test_hanaper.py cover:
- rejecting two sources from the same host
- preventing an operator from being its own regulator
- blocking early resolution before resolve_after
- allowing a timeout unlock once the bond is eligible
- ensuring UNKNOWN outcomes do not forfeit the bond

These checks reflect the current live contract behavior and the test state in this repository.