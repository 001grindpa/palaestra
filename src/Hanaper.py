# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlparse

from genlayer import *


DATE_RE = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
HTTPS = "https://"
MAX_PAGE_CHARS = 12000
MIN_TEXT_CHARS = 8
ZERO = Address("0x0000000000000000000000000000000000000000")

ALLOWED_HOSTS = (
    "gov.uk",
    "www.gov.uk",
    "legislation.gov.uk",
    "www.legislation.gov.uk",
    "thegazette.co.uk",
    "www.thegazette.co.uk",
    "federalregister.gov",
    "www.federalregister.gov",
    "regulations.gov",
    "www.regulations.gov",
    "sec.gov",
    "www.sec.gov",
    "fincen.gov",
    "www.fincen.gov",
    "canada.ca",
    "www.canada.ca",
    "gc.ca",
    "www.gc.ca",
    "europa.eu",
    "eur-lex.europa.eu",
    "github.com",
    "www.github.com",
    "gitlab.com",
    "www.gitlab.com",
    "reuters.com",
    "www.reuters.com",
    "bbc.com",
    "www.bbc.com",
    "apnews.com",
    "www.apnews.com",
)

ALLOWED_SUFFIXES = (
    ".gov",
    ".gov.uk",
    ".gov.au",
    ".gov.ng",
    ".gc.ca",
    ".europa.eu",
)


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def _host_allowed(url: str) -> bool:
    host = _host(url)
    if not host:
        return False
    for allowed in ALLOWED_HOSTS:
        base = allowed[4:] if allowed.startswith("www.") else allowed
        if host == allowed or host == base or host.endswith("." + base):
            return True
    for suffix in ALLOWED_SUFFIXES:
        if host.endswith(suffix):
            return True
    return False


def _require_https_url(url: str, label: str) -> str:
    cleaned = url.strip()
    if not cleaned.lower().startswith(HTTPS):
        raise gl.vm.UserError(f"{label} must be an https url")
    if not _host_allowed(cleaned):
        raise gl.vm.UserError(f"{label} host is not on the source allowlist")
    return cleaned


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _pay(to: Address, amount: u256) -> None:
    if amount == 0:
        return
    gl.get_contract_at(to).emit_transfer(value=amount, on="finalized")


@allow_storage
@dataclass
class Bond:
    operator: Address
    regulator: Address
    license_ref: str
    expiry_date: str
    resolve_after: str
    registry_url: str
    gazette_url: str
    amount: u256
    reserved: u256
    status: str
    verdict: str
    funds_disposition: str


class Hanaper(gl.Contract):
    bonds: TreeMap[str, Bond]
    next_bond_id: u256
    reserved_bonds: u256

    def __init__(self):
        self.next_bond_id = u256(1)
        self.reserved_bonds = u256(0)

    def _id(self) -> str:
        return str(int(self.next_bond_id))

    def _get(self, bond_id: str) -> Bond:
        if bond_id not in self.bonds:
            raise gl.vm.UserError("bond not found")
        return self.bonds[bond_id]

    def _ensure_resolvable(self, bond: Bond) -> None:
        today = _today_utc()
        if today < bond.resolve_after:
            raise gl.vm.UserError(
                "bond cannot be closed before resolve_after " + bond.resolve_after
            )

    def _lapse_payee(self, bond: Bond, caller: Address) -> Address:
        if bond.regulator != ZERO:
            return bond.regulator
        if caller == ZERO or caller == bond.operator:
            raise gl.vm.UserError("challenger cannot be the operator")
        return caller

    def _extract_page(self, url: str, license_ref: str, expiry_date: str) -> dict:
        failed = {"date_match": False, "related": False, "answer": "UNKNOWN"}
        try:
            raw = gl.nondet.web.render(url, mode="text")
            page_text = raw if isinstance(raw, str) else str(raw)
            page_text = page_text[:MAX_PAGE_CHARS]
        except Exception:
            return failed

        prompt = f"""
Decide whether one official page shows that a named permit stayed valid through a calendar day.

License reference: {license_ref}
Expiry / validity date (YYYY-MM-DD): {expiry_date}
Source URL: {url}

Page text:
{page_text}

Return JSON only:
{{
  "date_match": true or false,
  "related": true or false,
  "answer": "YES" or "NO" or "UNKNOWN"
}}
Rules:
- related is true only if the page is about this license, permit, venue, exporter, or transmitter.
- date_match is true only if the page speaks to validity on that calendar day.
- answer is YES only if the permit was still valid through that date.
- answer is NO only if the permit lapsed, expired, was revoked, or was not valid through that date.
- UNKNOWN if incomplete, off-topic, undated, or inconclusive.
"""
        try:
            parsed = gl.nondet.exec_prompt(prompt, response_format="json")
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
        except Exception:
            return failed

        date_match = bool(parsed.get("date_match", False))
        related = bool(parsed.get("related", False))
        answer = str(parsed.get("answer", "UNKNOWN")).upper()
        if answer not in ("YES", "NO", "UNKNOWN"):
            answer = "UNKNOWN"
        if not date_match or not related:
            answer = "UNKNOWN"
        return {"date_match": date_match, "related": related, "answer": answer}

    def _decision(self, bond: Bond) -> dict:
        try:
            page_a = self._extract_page(bond.registry_url, bond.license_ref, bond.expiry_date)
            page_b = self._extract_page(bond.gazette_url, bond.license_ref, bond.expiry_date)
        except Exception:
            return {"verdict": "UNKNOWN"}

        if (
            page_a["answer"] == "UNKNOWN"
            or page_b["answer"] == "UNKNOWN"
            or not page_a["date_match"]
            or not page_b["date_match"]
            or not page_a["related"]
            or not page_b["related"]
        ):
            verdict = "UNKNOWN"
        elif page_a["answer"] != page_b["answer"]:
            verdict = "DISAGREE"
        elif page_a["answer"] == "YES":
            verdict = "VALID"
        else:
            verdict = "LAPSED"
        return {"verdict": verdict}

    def _adjudicate(self, bond: Bond) -> dict:
        def leader_fn() -> str:
            return json.dumps(self._decision(bond), sort_keys=True, separators=(",", ":"))

        def validator_fn(leader_result) -> bool:
            payload = leader_result
            if hasattr(leader_result, "calldata"):
                payload = leader_result.calldata
            if isinstance(payload, (bytes, bytearray)):
                payload = payload.decode("utf-8", errors="replace")
            if not isinstance(payload, str):
                payload = str(payload)
            try:
                leader = json.loads(payload)
            except Exception:
                return False
            own = self._decision(bond)
            return own.get("verdict") == str(leader.get("verdict", "")).upper()

        try:
            raw = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        except Exception:
            return {"verdict": "UNKNOWN"}
        try:
            if isinstance(raw, str):
                return json.loads(raw)
            if hasattr(raw, "calldata"):
                data = raw.calldata
                return json.loads(data if isinstance(data, str) else str(data))
            return json.loads(str(raw))
        except Exception:
            return {"verdict": "UNKNOWN"}

    @gl.public.write.payable
    def post_bond(
        self,
        license_ref: str,
        expiry_date: str,
        resolve_after: str,
        registry_url: str,
        gazette_url: str,
        regulator: str,
    ) -> str:
        if len(license_ref.strip()) < MIN_TEXT_CHARS:
            raise gl.vm.UserError("license_ref is too short")
        if re.match(DATE_RE, expiry_date.strip()) is None:
            raise gl.vm.UserError("expiry_date must be YYYY-MM-DD")
        if re.match(DATE_RE, resolve_after.strip()) is None:
            raise gl.vm.UserError("resolve_after must be YYYY-MM-DD")
        if resolve_after.strip() < expiry_date.strip():
            raise gl.vm.UserError("resolve_after must be on or after expiry_date")

        amount = gl.message.value
        if amount == u256(0):
            raise gl.vm.UserError("bond must be greater than zero")

        url_a = _require_https_url(registry_url, "registry_url")
        url_b = _require_https_url(gazette_url, "gazette_url")
        if _host(url_a) == _host(url_b):
            raise gl.vm.UserError("sources must come from two different hosts")

        cleaned_regulator = regulator.strip()
        regulator_addr = ZERO if cleaned_regulator == "" else Address(cleaned_regulator)
        if regulator_addr == gl.message.sender_address:
            raise gl.vm.UserError("regulator cannot be the operator")

        bond_id = self._id()
        self.bonds[bond_id] = Bond(
            operator=gl.message.sender_address,
            regulator=regulator_addr,
            license_ref=license_ref.strip(),
            expiry_date=expiry_date.strip(),
            resolve_after=resolve_after.strip(),
            registry_url=url_a,
            gazette_url=url_b,
            amount=amount,
            reserved=amount,
            status="POSTED",
            verdict="UNRESOLVED",
            funds_disposition="RESERVED",
        )
        self.next_bond_id = self.next_bond_id + u256(1)
        self.reserved_bonds = self.reserved_bonds + amount
        return bond_id

    @gl.public.write
    def resolve(self, bond_id: str) -> str:
        bond = self._get(bond_id)
        if bond.status != "POSTED":
            raise gl.vm.UserError("bond is not posted")
        self._ensure_resolvable(bond)

        result = self._adjudicate(bond)
        verdict = str(result.get("verdict", "UNKNOWN")).upper()
        amount = bond.amount

        if verdict == "VALID":
            operator = bond.operator
            bond.status = "RELEASED"
            bond.verdict = "VALID"
            bond.reserved = u256(0)
            bond.funds_disposition = "RETURNED_TO_OPERATOR"
            self.reserved_bonds = self.reserved_bonds - amount
            self.bonds[bond_id] = bond
            _pay(operator, amount)
        elif verdict == "LAPSED":
            payee = self._lapse_payee(bond, gl.message.sender_address)
            bond.status = "FORFEITED"
            bond.verdict = "LAPSED"
            bond.reserved = u256(0)
            bond.funds_disposition = "PAID_TO_CHALLENGER"
            self.reserved_bonds = self.reserved_bonds - amount
            self.bonds[bond_id] = bond
            _pay(payee, amount)
        else:
            bond.verdict = verdict if verdict in ("UNKNOWN", "DISAGREE") else "UNKNOWN"
            self.bonds[bond_id] = bond
        return self.bonds[bond_id].status

    @gl.public.write
    def timeout_unlock(self, bond_id: str) -> None:
        bond = self._get(bond_id)
        if bond.status != "POSTED":
            raise gl.vm.UserError("only a posted bond can be timeout-unlocked")
        self._ensure_resolvable(bond)
        amount = bond.amount
        operator = bond.operator
        bond.status = "UNLOCKED"
        bond.verdict = "TIMEOUT"
        bond.reserved = u256(0)
        bond.funds_disposition = "RETURNED_TO_OPERATOR"
        self.reserved_bonds = self.reserved_bonds - amount
        self.bonds[bond_id] = bond
        _pay(operator, amount)

    @gl.public.view
    def can_resolve(self, bond_id: str) -> str:
        bond = self._get(bond_id)
        today = _today_utc()
        allowed = bond.status == "POSTED" and today >= bond.resolve_after
        return json.dumps(
            {
                "status": bond.status,
                "expiry_date": bond.expiry_date,
                "resolve_after": bond.resolve_after,
                "now_utc": today,
                "allowed": allowed,
                "timeout_unlock_allowed": allowed,
            },
            sort_keys=True,
        )

    @gl.public.view
    def get_bond(self, bond_id: str) -> str:
        bond = self._get(bond_id)
        return json.dumps(
            {
                "operator": bond.operator.as_hex,
                "regulator": bond.regulator.as_hex,
                "license_ref": bond.license_ref,
                "expiry_date": bond.expiry_date,
                "resolve_after": bond.resolve_after,
                "registry_url": bond.registry_url,
                "gazette_url": bond.gazette_url,
                "amount": str(int(bond.amount)),
                "reserved": str(int(bond.reserved)),
                "status": bond.status,
                "verdict": bond.verdict,
                "funds_disposition": bond.funds_disposition,
            },
            sort_keys=True,
        )

    @gl.public.view
    def get_bond_count(self) -> str:
        return str(int(self.next_bond_id) - 1)

    @gl.public.view
    def get_reserved_bonds(self) -> str:
        return str(int(self.reserved_bonds))