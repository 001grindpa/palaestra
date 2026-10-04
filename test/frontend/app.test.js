import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_ID,
  ABI,
  state,
  parseStake,
  validatePair,
  ensureWalletReady,
  executeWriteFlow,
} from "../../static/app.js";

describe("Palaestra", () => {
  beforeEach(() => {
    state.provider = null;
    state.walletAddress = "";
    state.chainId = null;
    state.inFlight = false;
  });

  it("parses stake with bigint only", () => {
    assert.equal(parseStake("0.05"), 50000000000000000n);
    assert.equal(parseStake("1"), 1000000000000000000n);
    assert.throws(() => parseStake("0"), /greater than zero/);
    assert.throws(() => parseStake("1.0000000000000000001"), /18/);
  });

  it("requires two different allowlisted hosts", () => {
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
});