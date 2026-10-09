# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from genlayer import *


HTTPS = "https://"
MAX_PAGE_CHARS = 12000
MIN_QUESTION_CHARS = 12
REFUND_GRACE_DAYS = 1
ZERO = Address("0x0000000000000000000000000000000000000000")

ALLOWED_HOSTS = (
    "bbc.com",
    "www.bbc.com",
    "espn.com",
    "www.espn.com",
    "reuters.com",
    "www.reuters.com",
    "apnews.com",
    "www.apnews.com",
    "theguardian.com",
    "www.theguardian.com",
    "nytimes.com",
    "www.nytimes.com",
    "skysports.com",
    "www.skysports.com",
    "goal.com",
    "www.goal.com",
    "flashscore.com",
    "www.flashscore.com",
    "sofascore.com",
    "www.sofascore.com",
    "cbssports.com",
    "www.cbssports.com",
    "nfl.com",
    "www.nfl.com",
    "nba.com",
    "www.nba.com",
    "mlb.com",
    "www.mlb.com",
    "nhl.com",
    "www.nhl.com",
    "fifa.com",
    "www.fifa.com",
    "uefa.com",
    "www.uefa.com",
    "premierleague.com",
    "www.premierleague.com",
    "en.wikipedia.org",
    "wikipedia.org",
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
    return False


def _require_https_url(url: str, label: str) -> str:
    cleaned = url.strip()
    if not cleaned.lower().startswith(HTTPS):
        raise gl.vm.UserError(f"{label} must be an https url")
    if not _host_allowed(cleaned):
        raise gl.vm.UserError(f"{label} host is not on the source allowlist")
    return cleaned


def _require_date(value: str, label: str) -> str:
    cleaned = value.strip()
    try:
        datetime.strptime(cleaned, "%Y-%m-%d")
    except ValueError:
        raise gl.vm.UserError(label + " must be a real calendar date YYYY-MM-DD")
    return cleaned


def _add_days(day: str, days: int) -> str:
    return (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@gl.evm.contract_interface
class _Wallet:
    class View:
        pass

    class Write:
        pass


def _pay(to: Address, amount: u256) -> None:
    if amount == 0:
        return
    if to == ZERO:
        raise gl.vm.UserError("cannot pay the zero address")
    _Wallet(to).emit_transfer(value=amount)


@allow_storage
@dataclass
class Wager:
    creator: Address
    joiner: Address
    question: str
    event_date: str
    resolve_after: str
    refund_after: str
    creator_side: str
    source_url_a: str
    source_url_b: str
    stake: u256
    status: str
    verdict: str
    funds_disposition: str


class EventWager(gl.Contract):
    wagers: TreeMap[str, Wager]
    next_wager_id: u256
    reserved_stakes: u256

    def __init__(self):
        self.next_wager_id = u256(1)
        self.reserved_stakes = u256(0)

    def _id(self) -> str:
        return str(int(self.next_wager_id))

    def _get(self, wager_id: str) -> Wager:
        if wager_id not in self.wagers:
            raise gl.vm.UserError("wager not found")
        return self.wagers[wager_id]

    def _ensure_resolvable(self, wager: Wager) -> None:
        today = _today_utc()
        if today < wager.resolve_after:
            raise gl.vm.UserError(
                "wager cannot be closed before resolve_after " + wager.resolve_after
            )
        if today >= wager.refund_after:
            raise gl.vm.UserError(
                "resolve is closed; use timeout_refund after a recorded disagreement"
            )

    def _ensure_refundable(self, wager: Wager) -> None:
        if wager.verdict not in ("UNKNOWN", "DISAGREE"):
            raise gl.vm.UserError("timeout_refund requires a recorded UNKNOWN or DISAGREE")
        today = _today_utc()
        if today < wager.refund_after:
            raise gl.vm.UserError(
                "timeout_refund cannot run before refund_after " + wager.refund_after
            )

    def _refund_both(self, wager_id: str, wager: Wager, verdict: str) -> None:
        pot = wager.stake + wager.stake
        creator = wager.creator
        joiner = wager.joiner
        stake = wager.stake
        wager.status = "REFUNDED"
        wager.verdict = verdict
        wager.funds_disposition = "REFUNDED_TO_BOTH"
        self.reserved_stakes = self.reserved_stakes - pot
        self.wagers[wager_id] = wager
        _pay(creator, stake)
        _pay(joiner, stake)

    def _extract_page(self, url: str, question: str, event_date: str) -> dict:
        failed = {"date_match": False, "related": False, "answer": "UNKNOWN"}
        try:
            raw = gl.nondet.web.render(url, mode="text")
            page_text = raw if isinstance(raw, str) else str(raw)
            page_text = page_text[:MAX_PAGE_CHARS]
        except Exception:
            return failed

        prompt = f"""
Decide whether one public page answers a dated yes/no event question.

Question: {question}
Required calendar date (YYYY-MM-DD): {event_date}
Source URL: {url}

Page text:
{page_text}

Return JSON only with exactly these fields:
{{
  "date_match": true or false,
  "related": true or false,
  "answer": "YES" or "NO" or "UNKNOWN"
}}
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

    def _decision(self, wager: Wager) -> dict:
        try:
            page_a = self._extract_page(wager.source_url_a, wager.question, wager.event_date)
            page_b = self._extract_page(wager.source_url_b, wager.question, wager.event_date)
        except Exception:
            return {"verdict": "UNKNOWN"}

        if (
            not page_a["date_match"]
            or not page_b["date_match"]
            or not page_a["related"]
            or not page_b["related"]
            or page_a["answer"] == "UNKNOWN"
            or page_b["answer"] == "UNKNOWN"
        ):
            verdict = "UNKNOWN"
        elif page_a["answer"] != page_b["answer"]:
            verdict = "DISAGREE"
        else:
            verdict = page_a["answer"]
        return {"verdict": verdict}

    def _adjudicate(self, wager: Wager) -> dict:
        def leader_fn() -> str:
            return json.dumps(self._decision(wager), sort_keys=True, separators=(",", ":"))

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
            own = self._decision(wager)
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
    def create_wager(
        self,
        question: str,
        event_date: str,
        resolve_after: str,
        side: str,
        source_url_a: str,
        source_url_b: str,
    ) -> str:
        text = question.strip()
        if len(text) < MIN_QUESTION_CHARS:
            raise gl.vm.UserError("question is too short")
        event_date = _require_date(event_date, "event_date")
        resolve_after = _require_date(resolve_after, "resolve_after")
        if resolve_after < event_date:
            raise gl.vm.UserError("resolve_after must be on or after event_date")
        side_u = side.strip().upper()
        if side_u not in ("YES", "NO"):
            raise gl.vm.UserError("side must be YES or NO")
        url_a = _require_https_url(source_url_a, "source_url_a")
        url_b = _require_https_url(source_url_b, "source_url_b")
        if _host(url_a) == _host(url_b):
            raise gl.vm.UserError("sources must come from two different hosts")
        stake = gl.message.value
        if stake == u256(0):
            raise gl.vm.UserError("stake must be greater than zero")

        wager_id = self._id()
        self.wagers[wager_id] = Wager(
            creator=gl.message.sender_address,
            joiner=ZERO,
            question=text,
            event_date=event_date,
            resolve_after=resolve_after,
            refund_after=_add_days(resolve_after, REFUND_GRACE_DAYS),
            creator_side=side_u,
            source_url_a=url_a,
            source_url_b=url_b,
            stake=stake,
            status="OPEN",
            verdict="",
            funds_disposition="RESERVED",
        )
        self.next_wager_id = self.next_wager_id + u256(1)
        self.reserved_stakes = self.reserved_stakes + stake
        return wager_id

    @gl.public.write.payable
    def join(self, wager_id: str) -> None:
        wager = self._get(wager_id)
        if wager.status != "OPEN":
            raise gl.vm.UserError("wager is not open")
        if gl.message.sender_address == wager.creator:
            raise gl.vm.UserError("creator cannot join")
        if gl.message.value != wager.stake:
            raise gl.vm.UserError("join stake must match")
        wager.joiner = gl.message.sender_address
        wager.status = "MATCHED"
        self.reserved_stakes = self.reserved_stakes + wager.stake
        self.wagers[wager_id] = wager

    @gl.public.write
    def cancel(self, wager_id: str) -> None:
        wager = self._get(wager_id)
        if gl.message.sender_address != wager.creator:
            raise gl.vm.UserError("only the creator can cancel")
        if wager.status == "MATCHED":
            raise gl.vm.UserError("matched wagers close via resolve or timeout_refund")
        if wager.status != "OPEN":
            raise gl.vm.UserError("only an open unmatched wager can be cancelled")
        stake = wager.stake
        creator = wager.creator
        wager.status = "CANCELLED"
        wager.funds_disposition = "REFUNDED_TO_CREATOR"
        self.reserved_stakes = self.reserved_stakes - stake
        self.wagers[wager_id] = wager
        _pay(creator, stake)

    @gl.public.write
    def resolve(self, wager_id: str) -> str:
        wager = self._get(wager_id)
        if wager.status != "MATCHED":
            raise gl.vm.UserError("wager must be MATCHED to resolve")
        self._ensure_resolvable(wager)

        result = self._adjudicate(wager)
        verdict = str(result.get("verdict", "UNKNOWN")).upper()
        pot = wager.stake + wager.stake

        if verdict in ("YES", "NO"):
            winner = wager.creator if wager.creator_side == verdict else wager.joiner
            wager.status = "SETTLED"
            wager.verdict = verdict
            wager.funds_disposition = "PAID_TO_WINNER"
            self.reserved_stakes = self.reserved_stakes - pot
            self.wagers[wager_id] = wager
            _pay(winner, pot)
        else:
            wager.verdict = verdict if verdict in ("UNKNOWN", "DISAGREE") else "UNKNOWN"
            self.wagers[wager_id] = wager
        return self.wagers[wager_id].status

    @gl.public.write
    def timeout_refund(self, wager_id: str) -> None:
        wager = self._get(wager_id)
        if wager.status != "MATCHED":
            raise gl.vm.UserError("only a matched wager can be timeout-refunded")
        if wager.joiner == ZERO:
            raise gl.vm.UserError("wager is not matched")
        self._ensure_refundable(wager)
        self._refund_both(wager_id, wager, "TIMEOUT")

    @gl.public.view
    def can_resolve(self, wager_id: str) -> str:
        wager = self._get(wager_id)
        today = _today_utc()
        matched = wager.status == "MATCHED"
        recorded = wager.verdict in ("UNKNOWN", "DISAGREE")
        return json.dumps(
            {
                "status": wager.status,
                "event_date": wager.event_date,
                "resolve_after": wager.resolve_after,
                "refund_after": wager.refund_after,
                "verdict": wager.verdict,
                "now_utc": today,
                "allowed": matched and today >= wager.resolve_after and today < wager.refund_after,
                "timeout_refund_allowed": matched and recorded and today >= wager.refund_after,
            },
            sort_keys=True,
        )

    @gl.public.view
    def get_wager(self, wager_id: str) -> str:
        wager = self._get(wager_id)
        return json.dumps(
            {
                "creator": wager.creator.as_hex,
                "joiner": wager.joiner.as_hex,
                "question": wager.question,
                "event_date": wager.event_date,
                "resolve_after": wager.resolve_after,
                "refund_after": wager.refund_after,
                "creator_side": wager.creator_side,
                "source_url_a": wager.source_url_a,
                "source_url_b": wager.source_url_b,
                "stake": str(int(wager.stake)),
                "status": wager.status,
                "verdict": wager.verdict,
                "funds_disposition": wager.funds_disposition,
            },
            sort_keys=True,
        )

    @gl.public.view
    def get_wager_count(self) -> str:
        return str(int(self.next_wager_id) - 1)

    @gl.public.view
    def get_reserved_stakes(self) -> str:
        return str(int(self.reserved_stakes))