import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

const app = await import("../../static/app.js");
const {
  CHAIN_ID,
  ABI,
  state,
  parseStake,
  validatePair,
  ensureWalletReady,
  executeWriteFlow,
  readWager,
} = app;

if (!state) {
  throw new Error("static/app.js must export state");
}

describe("Palaestra", () => {
  beforeEach(() => {
    state.provider = null;
    state.walletAddress = "";
    state.chainId = null;
    state.inFlight = false;
    state.client = null;
    state.readClient = null;
  });

  it("parses stake with bigint only", () => {
    assert.equal(typeof parseStake, "function");
    assert.equal(parseStake("0.05"), 50000000000000000n);
    assert.equal(parseStake("1"), 1000000000000000000n);
    assert.throws(() => parseStake("0"), /greater than zero/);
    assert.throws(() => parseStake("1.0000000000000000001"), /18/);
  });

  it("requires two different allowlisted hosts", () => {
    assert.equal(typeof validatePair, "function");
    assert.throws(
      () => validatePair("https://www.bbc.com/sport", "https://www.bbc.com/news"),
      /different hosts/
    );
    const pair = validatePair(
      "https://www.bbc.com/sport",
      "https://www.skysports.com/football"
    );
    assert.equal(pair.length, 2);
  });

  it("refuses a write on the wrong chain", async () => {
    state.walletAddress = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    state.provider = { request: async () => "0x1" };
    await assert.rejects(() => ensureWalletReady(), /61999|StudioNet|chain/);
    assert.equal(CHAIN_ID, 61999);
  });

  it("joins with the matched stake", async () => {
    state.walletAddress = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    state.chainId = 61999;
    state.provider = { request: async () => "0xf22f" };
    const hash = "0x" + "ab".repeat(32);
    state.client = {
      writeContract: async (payload) => {
        assert.equal(payload.functionName, "join");
        assert.equal(payload.value, 50000000000000000n);
        return hash;
      },
      waitForTransactionReceipt: async () => ({ status: 7, statusName: "FINALIZED" }),
    };
    const out = await executeWriteFlow("join", ["1"], 50000000000000000n, async () => {});
    assert.equal(out, hash);
    assert.equal(ABI.find((item) => item.name === "timeout_refund").inputs.length, 1);
  });

  it("uses a defined account in lookup read payloads", async () => {
    let lookupPayload;
    state.readClient = {
      readContract: async (payload) => {
        lookupPayload = payload;
        return JSON.stringify({ status: "MATCHED" });
      },
    };

    await readWager("1");
    assert.equal(lookupPayload.account?.address, "0x0000000000000000000000000000000000000000");
  });
});