/**
 * Palaestra — Two-Sided Dated Contest Match Book
 * Client Controller & GenLayer StudioNet Integration
 */

// ============================================================================
// Constants & Configuration
// ============================================================================
const CONTRACT_ADDRESS = "0x05Ea4308905A80354515B991a35f1BE09186eB1C";
const CHAIN_ID_DECIMAL = 61999;
const CHAIN_ID_HEX = "0xf22f";
const RPC_ENDPOINT = "https://studio.genlayer.com/api";
const EXPLORER_BASE = "https://explorer-studio.genlayer.com";

const STUDIONET_CHAIN = {
  id: CHAIN_ID_DECIMAL,
  name: "GenLayer StudioNet",
  rpcUrls: {
    default: {
      http: [RPC_ENDPOINT]
    }
  },
  nativeCurrency: {
    name: "GEN Token",
    symbol: "GEN",
    decimals: 18
  },
  blockExplorers: {
    default: {
      name: "GenLayer Explorer",
      url: EXPLORER_BASE
    }
  }
};

const STORAGE_KEYS = {
  VIEW: "palaestra.view",
  WALLET: "palaestra.wallet",
  THEME: "palaestra.theme"
};

const ALLOWED_HOSTS = [
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
  "wikipedia.org",
  "en.wikipedia.org"
];

// ============================================================================
// State
// ============================================================================
const state = {
  client: null,
  walletAddress: null,
  chainId: null,
  injectedProvider: null,
  isWriteInFlight: false,
  detectedEip6963Providers: []
};

// ============================================================================
// Calldata Binary Encoder / Decoder for Direct RPC Fallback & Client
// ============================================================================
const CAL_SHIFT = 3, CAL_TAG_INT = 1, CAL_TAG_NEG = 2, CAL_TAG_BYTES = 3, CAL_TAG_STR = 4, CAL_TAG_ARR = 5, CAL_TAG_MAP = 6;
const CAL_NULL = 0 << CAL_SHIFT | 0, CAL_FALSE = 1 << CAL_SHIFT | 0, CAL_TRUE = 2 << CAL_SHIFT | 0;

function encodeVarInt(target, val) {
  if (val === 0n) { target.push(0); return; }
  while (val > 0n) {
    let b = Number(val & 0x7fn);
    val >>= 7n;
    if (val > 0n) b |= 128;
    target.push(b);
  }
}

function encodeTaggedInt(target, val, tag) {
  const composite = (val << BigInt(CAL_SHIFT)) | BigInt(tag);
  encodeVarInt(target, composite);
}

function encodeInt(target, val) {
  if (val >= 0n) encodeTaggedInt(target, val, CAL_TAG_INT);
  else encodeTaggedInt(target, -val - 1n, CAL_TAG_NEG);
}

function compareByteArrays(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function encodeMap(target, entries) {
  const enc = new TextEncoder();
  const sorted = Array.from(entries, ([k, v]) => [Array.from(k, c => c.codePointAt(0)), enc.encode(k), v]);
  sorted.sort((a, b) => compareByteArrays(a[0], b[0]));
  encodeTaggedInt(target, BigInt(sorted.length), CAL_TAG_MAP);
  for (const [, keyBytes, val] of sorted) {
    encodeVarInt(target, BigInt(keyBytes.length));
    for (const b of keyBytes) target.push(b);
    serializeValue(target, val);
  }
}

function serializeValue(target, val) {
  if (val === null || val === undefined) { target.push(CAL_NULL); return; }
  if (val === true) { target.push(CAL_TRUE); return; }
  if (val === false) { target.push(CAL_FALSE); return; }
  
  const valType = typeof val;
  if (valType === "number") {
    encodeInt(target, BigInt(val));
    return;
  }
  if (valType === "bigint") {
    encodeInt(target, val);
    return;
  }
  if (valType === "string") {
    const utf8 = new TextEncoder().encode(val);
    encodeTaggedInt(target, BigInt(utf8.length), CAL_TAG_STR);
    for (const b of utf8) target.push(b);
    return;
  }
  if (Array.isArray(val)) {
    encodeTaggedInt(target, BigInt(val.length), CAL_TAG_ARR);
    for (const el of val) serializeValue(target, el);
    return;
  }
  if (val instanceof Uint8Array) {
    encodeTaggedInt(target, BigInt(val.length), CAL_TAG_BYTES);
    for (const b of val) target.push(b);
    return;
  }
  if (valType === "object") {
    encodeMap(target, Object.entries(val));
    return;
  }
  throw new Error(`Cannot serialize unsupported value: ${val}`);
}

function encodeCalldata(methodName, args = []) {
  const target = [];
  const methodBytes = new TextEncoder().encode(methodName);
  encodeVarInt(target, BigInt(methodBytes.length));
  for (const b of methodBytes) target.push(b);

  encodeTaggedInt(target, BigInt(args.length), CAL_TAG_ARR);
  for (const arg of args) serializeValue(target, arg);

  encodeMap(target, []);
  return "0x" + Array.from(target, b => b.toString(16).padStart(2, "0")).join("");
}

class ByteReader {
  constructor(u8) {
    this.buf = u8;
    this.pos = 0;
  }
  get remaining() { return this.buf.length - this.pos; }
  readByte() {
    if (this.pos >= this.buf.length) throw new Error("Unexpected end of calldata buffer");
    return this.buf[this.pos++];
  }
  readVarInt() {
    let result = 0n, shift = 0n;
    while (true) {
      const byte = this.readByte();
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7n;
    }
    return result;
  }
  readSlice(len) {
    const end = this.pos + Number(len);
    if (end > this.buf.length) throw new Error("Slice out of bounds in calldata buffer");
    const sl = this.buf.subarray(this.pos, end);
    this.pos = end;
    return sl;
  }
}

function deserializeValue(reader) {
  const composite = reader.readVarInt();
  const tag = Number(composite & 7n);
  const val = composite >> 3n;

  if (tag === 0) {
    const code = Number(val);
    if (code === 0) return null;
    if (code === 1) return false;
    if (code === 2) return true;
    throw new Error(`Unknown calldata code: ${code}`);
  }
  if (tag === CAL_TAG_INT) return val;
  if (tag === CAL_TAG_NEG) return -val - 1n;
  if (tag === CAL_TAG_BYTES) return reader.readSlice(val);
  if (tag === CAL_TAG_STR) return new TextDecoder().decode(reader.readSlice(val));
  if (tag === CAL_TAG_ARR) {
    const count = Number(val);
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(deserializeValue(reader));
    return arr;
  }
  if (tag === CAL_TAG_MAP) {
    const count = Number(val);
    const obj = {};
    for (let i = 0; i < count; i++) {
      const keyLen = reader.readVarInt();
      const keyStr = new TextDecoder().decode(reader.readSlice(keyLen));
      obj[keyStr] = deserializeValue(reader);
    }
    return obj;
  }
  throw new Error(`Unknown calldata tag: ${tag}`);
}

function decodeCalldataResult(hexStr) {
  if (!hexStr || hexStr === "0x") return null;
  const clean = hexStr.startsWith("0x") ? hexStr.slice(2) : hexStr;
  const u8 = new Uint8Array(clean.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  const reader = new ByteReader(u8);
  return deserializeValue(reader);
}

// ============================================================================
// Pure BigInt Currency Conversion (Zero Number / Math.round)
// ============================================================================
function parseGenToWei(genStr) {
  if (!genStr || typeof genStr !== "string") {
    throw new Error("Invalid stake amount");
  }
  const trimmed = genStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Invalid GEN format. Use positive decimal (e.g. 1.5 or 10)");
  }

  const parts = trimmed.split(".");
  const integerPart = parts[0];
  const fractionalPart = parts[1] || "";

  if (fractionalPart.length > 18) {
    throw new Error("Maximum 18 decimal places supported for GEN amounts");
  }

  const paddedFraction = fractionalPart.padEnd(18, "0");
  const wholeUnits = BigInt(integerPart) * 10n ** 18n;
  const fractionUnits = BigInt(paddedFraction);
  const totalWei = wholeUnits + fractionUnits;

  if (totalWei <= 0n) {
    throw new Error("Stake must be strictly greater than 0 GEN");
  }

  return totalWei;
}

function formatWeiToGen(weiVal) {
  if (weiVal === null || weiVal === undefined) return "0 GEN";
  const weiBig = typeof weiVal === "bigint" ? weiVal : BigInt(weiVal.toString());
  const isNeg = weiBig < 0n;
  const absWei = isNeg ? -weiBig : weiBig;

  const base = 10n ** 18n;
  const whole = absWei / base;
  const rem = absWei % base;

  if (rem === 0n) {
    return `${isNeg ? "-" : ""}${whole.toString()} GEN`;
  }

  let remStr = rem.toString().padStart(18, "0");
  remStr = remStr.replace(/0+$/, "");
  return `${isNeg ? "-" : ""}${whole.toString()}.${remStr} GEN`;
}

function shortenAddress(addr) {
  if (!addr || typeof addr !== "string") return "—";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ============================================================================
// GenLayer Client & Direct JSON-RPC Integration
// ============================================================================
let genlayerModule = null;

async function getGenLayerClient() {
  if (state.client) return state.client;
  try {
    if (!genlayerModule) {
      genlayerModule = await import("https://esm.sh/genlayer@0.18.0");
    }
    if (genlayerModule && typeof genlayerModule.createClient === "function") {
      state.client = genlayerModule.createClient({
        chain: STUDIONET_CHAIN
      });
      return state.client;
    }
  } catch (err) {
    console.warn("Dynamic import of esm.sh/genlayer skipped or failed, using direct JSON-RPC:", err);
  }
  return null;
}

async function callDirectRpc(method, params) {
  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }
  return json.result;
}

// Read Contract View Methods (Direct RPC or Client)
async function callContractView(methodName, args = [], stateStatus = "ACCEPTED") {
  const client = await getGenLayerClient();
  if (client && client.readContract) {
    try {
      const res = await client.readContract({
        address: CONTRACT_ADDRESS,
        functionName: methodName,
        args,
        stateStatus
      });
      return res;
    } catch (err) {
      console.warn(`client.readContract for ${methodName} error, falling back to raw RPC:`, err);
    }
  }

  // Direct RPC fallback
  const calldata = encodeCalldata(methodName, args);
  const rawHex = await callDirectRpc("gen_callViewMethod", [
    CONTRACT_ADDRESS,
    calldata,
    stateStatus
  ]);
  return decodeCalldataResult(rawHex);
}

// Read Wager Count
async function fetchWagerCount() {
  try {
    const res = await callContractView("get_wager_count", [], "ACCEPTED");
    return BigInt(res || 0n);
  } catch (err) {
    console.error("fetchWagerCount error:", err);
    return 0n;
  }
}

// Read Contract Total Reserved Stakes
async function fetchReservedStakes() {
  try {
    const count = await fetchWagerCount();
    let totalWei = 0n;

    for (let i = 1n; i <= count; i++) {
      try {
        const raw = await callContractView("get_wager", [i.toString()], "ACCEPTED");
        const wager = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (wager) {
          const stakeWei = BigInt(wager.stake || "0");
          if (wager.status === "OPEN") {
            totalWei += stakeWei;
          } else if (wager.status === "MATCHED") {
            totalWei += stakeWei * 2n;
          }
        }
      } catch (err) {
        console.warn(`Error reading wager #${i}:`, err);
      }
    }
    return totalWei;
  } catch (err) {
    console.error("fetchReservedStakes error:", err);
    return 0n;
  }
}

// Refresh Top Bar Counters on Floor View
async function refreshFloorCounters() {
  const countEl = document.getElementById("app-wager-count");
  const reservedEl = document.getElementById("app-reserved-stakes");

  try {
    const count = await fetchWagerCount();
    if (countEl) countEl.textContent = count.toString();

    const reservedWei = await fetchReservedStakes();
    if (reservedEl) reservedEl.textContent = formatWeiToGen(reservedWei);
  } catch (err) {
    console.error("refreshFloorCounters error:", err);
  }
}

// ============================================================================
// EIP-6963 & Injected Wallet Provider Discovery
// ============================================================================
function initEip6963() {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = event.detail;
    if (!detail) return;
    const existing = state.detectedEip6963Providers.find(p => p.info.uuid === detail.info.uuid);
    if (!existing) {
      state.detectedEip6963Providers.push(detail);
    }
  });

  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function getPreferredProvider() {
  if (state.detectedEip6963Providers.length > 0) {
    const okx = state.detectedEip6963Providers.find(p => p.info.rdns === "com.okex.wallet");
    if (okx) return okx.provider;
    return state.detectedEip6963Providers[0].provider;
  }
  if (window.ethereum) return window.ethereum;
  if (window.okxwallet) return window.okxwallet;
  return null;
}

async function connectWallet() {
  const provider = getPreferredProvider();
  if (!provider) {
    showAlert("No Web3 wallet detected. Please install an EIP-6963 compatible wallet.", "error");
    return;
  }

  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts || accounts.length === 0) {
      showAlert("Wallet connection cancelled.", "error");
      return;
    }

    state.injectedProvider = provider;
    state.walletAddress = accounts[0];
    localStorage.setItem(STORAGE_KEYS.WALLET, state.walletAddress);

    // Verify / switch chain to StudioNet (61999)
    try {
      const chainIdHex = await provider.request({ method: "eth_chainId" });
      state.chainId = parseInt(chainIdHex, 16);

      if (state.chainId !== CHAIN_ID_DECIMAL) {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: CHAIN_ID_HEX }]
          });
        } catch (switchErr) {
          if (switchErr.code === 4902) {
            await provider.request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: CHAIN_ID_HEX,
                chainName: "GenLayer StudioNet",
                nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
                rpcUrls: [RPC_ENDPOINT],
                blockExplorerUrls: [EXPLORER_BASE]
              }]
            });
          }
        }
      }
    } catch (netErr) {
      console.warn("Chain verification error:", netErr);
    }

    updateWalletUI();
    showAlert(`Connected: ${shortenAddress(state.walletAddress)}`, "success");
  } catch (err) {
    console.error("Wallet connection failed:", err);
    showAlert(`Connection failed: ${err.message || err}`, "error");
  }
}

function disconnectWallet() {
  state.walletAddress = null;
  state.injectedProvider = null;
  localStorage.removeItem(STORAGE_KEYS.WALLET);
  updateWalletUI();
  showAlert("Wallet disconnected.", "info");
}

function updateWalletUI() {
  const connectBtn = document.getElementById("connect-wallet");
  const connectedGroup = document.getElementById("wallet-connected-group");
  const addrDisplay = document.getElementById("wallet-address-short");

  if (state.walletAddress) {
    if (connectBtn) connectBtn.classList.add("is-hidden");
    if (connectedGroup) connectedGroup.classList.remove("is-hidden");
    if (addrDisplay) {
      addrDisplay.textContent = shortenAddress(state.walletAddress);
      addrDisplay.title = state.walletAddress;
    }
  } else {
    if (connectBtn) connectBtn.classList.remove("is-hidden");
    if (connectedGroup) connectedGroup.classList.add("is-hidden");
  }
}

async function autoRestoreWallet() {
  const saved = localStorage.getItem(STORAGE_KEYS.WALLET);
  if (!saved) return;
  const provider = getPreferredProvider();
  if (!provider) return;

  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    if (accounts && accounts.length > 0 && accounts[0].toLowerCase() === saved.toLowerCase()) {
      state.injectedProvider = provider;
      state.walletAddress = accounts[0];
      updateWalletUI();
    }
  } catch (e) {
    console.warn("Auto restore wallet skipped:", e);
  }
}

// ============================================================================
// 7-Phase Write Flow Pipeline
// ============================================================================
const WRITE_PHASES = [
  "signature",
  "submitted",
  "wait finalized",
  "consensus",
  "execution",
  "read",
  "accepted"
];

function updateWriteFlowUI(phase, message, txHash = null) {
  const container = document.getElementById("write-flow-container");
  const msgEl = document.getElementById("flow-message");
  const hashWrap = document.getElementById("flow-hash-wrap");
  const stepper = document.getElementById("flow-stepper");

  if (!container) return;

  if (!phase) {
    container.classList.add("is-hidden");
    return;
  }

  container.classList.remove("is-hidden");
  if (msgEl) msgEl.textContent = message;

  if (hashWrap) {
    if (txHash) {
      hashWrap.innerHTML = `
        <a href="${EXPLORER_BASE}/tx/${txHash}" target="_blank" rel="noopener noreferrer" class="link-explorer">
          <span>TX: ${shortenAddress(txHash)}</span>
        </a>
      `;
    } else {
      hashWrap.innerHTML = "";
    }
  }

  if (stepper) {
    const currentIndex = WRITE_PHASES.indexOf(phase);
    const stepItems = stepper.querySelectorAll(".step-item");
    stepItems.forEach((item, index) => {
      item.classList.remove("is-active", "is-done");
      if (index < currentIndex) {
        item.classList.add("is-done");
      } else if (index === currentIndex) {
        item.classList.add("is-active");
      }
    });
  }
}

async function pollTransactionFinality(txHash) {
  const maxAttempts = 60;
  const intervalMs = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const receipt = await callDirectRpc("gen_getTransactionReceipt", [txHash]);
      if (receipt) {
        const status = (receipt.status || receipt.stateStatus || "").toUpperCase();
        if (status.includes("FINAL") || status === "FINALIZED" || status === "ACCEPTED" || status === "SUCCESS") {
          return receipt;
        }
      }
    } catch (err) {
      console.warn(`Receipt polling attempt ${attempt + 1}:`, err);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Transaction finality check timed out after 120s.");
}

async function executeContractWrite(methodName, args = [], valueWei = 0n, promptTitle = "Submitting Transaction") {
  if (!state.walletAddress || !state.injectedProvider) {
    showAlert("Please connect your wallet to execute this action.", "error");
    throw new Error("Wallet not connected");
  }

  state.isWriteInFlight = true;
  const titleEl = document.getElementById("flow-title");
  if (titleEl) titleEl.textContent = promptTitle;

  try {
    // Phase 1: Signature
    updateWriteFlowUI("signature", "Awaiting signature from your wallet...");
    const calldata = encodeCalldata(methodName, args);
    const valueHex = "0x" + valueWei.toString(16);

    const txParams = {
      from: state.walletAddress,
      to: CONTRACT_ADDRESS,
      data: calldata,
      value: valueHex
    };

    const txHash = await state.injectedProvider.request({
      method: "eth_sendTransaction",
      params: [txParams]
    });

    if (!txHash) throw new Error("Transaction rejected or no hash returned.");

    // Phase 2: Submitted
    updateWriteFlowUI("submitted", `Transaction submitted. Hash: ${txHash}`, txHash);

    // Phase 3: Wait Finalized
    updateWriteFlowUI("wait finalized", "Waiting for StudioNet block finality...", txHash);
    await pollTransactionFinality(txHash);

    // Phase 4: Consensus
    updateWriteFlowUI("consensus", "Validators reaching consensus...", txHash);
    await new Promise(r => setTimeout(r, 1500));

    // Phase 5: Execution
    updateWriteFlowUI("execution", "Executing smart contract state transitions...", txHash);
    await new Promise(r => setTimeout(r, 1000));

    // Phase 6: Read
    updateWriteFlowUI("read", "Reading back updated on-chain contract state...", txHash);
    await refreshFloorCounters();

    // Phase 7: Accepted
    updateWriteFlowUI("accepted", "State accepted and finalized on StudioNet!", txHash);
    await new Promise(r => setTimeout(r, 2000));

    updateWriteFlowUI(null, "");
    state.isWriteInFlight = false;
    return txHash;
  } catch (err) {
    state.isWriteInFlight = false;
    updateWriteFlowUI(null, "");
    showAlert(`Transaction failed: ${err.message || err}`, "error");
    throw err;
  }
}

// ============================================================================
// Form Validation & Field Helpers
// ============================================================================
function validateDateString(dStr, fieldName = "Date") {
  if (!dStr || typeof dStr !== "string") {
    return { valid: false, error: `${fieldName} is required.` };
  }
  const clean = dStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return { valid: false, error: `${fieldName} must match YYYY-MM-DD format.` };
  }
  const [y, m, d] = clean.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return { valid: false, error: `${fieldName} contains invalid calendar values.` };
  }
  return { valid: true, value: clean };
}

function validateUrls(urlA, urlB) {
  if (!urlA || !urlB) {
    return { valid: false, error: "Both source URLs are required." };
  }
  let hostA, hostB;
  try {
    const parsedA = new URL(urlA);
    if (parsedA.protocol !== "https:") return { valid: false, error: "Source A must use https://" };
    hostA = parsedA.hostname.toLowerCase();
  } catch (e) {
    return { valid: false, error: "Source A is not a valid URL." };
  }

  try {
    const parsedB = new URL(urlB);
    if (parsedB.protocol !== "https:") return { valid: false, error: "Source B must use https://" };
    hostB = parsedB.hostname.toLowerCase();
  } catch (e) {
    return { valid: false, error: "Source B is not a valid URL." };
  }

  if (!ALLOWED_HOSTS.includes(hostA)) {
    return { valid: false, error: `Host "${hostA}" is not in the allowlist.` };
  }
  if (!ALLOWED_HOSTS.includes(hostB)) {
    return { valid: false, error: `Host "${hostB}" is not in the allowlist.` };
  }
  if (hostA === hostB) {
    return { valid: false, error: "Source A and Source B must come from different allowlisted domains." };
  }
  return { valid: true, hostA, hostB };
}

function showAlert(message, type = "info") {
  const alertEl = document.getElementById("floor-alert");
  const textEl = document.getElementById("alert-text");
  const iconEl = document.getElementById("alert-icon");

  if (!alertEl || !textEl) return;

  alertEl.className = `floor-alert alert-${type}`;
  textEl.textContent = message;

  if (iconEl) {
    if (type === "success") iconEl.innerHTML = "&#10003;";
    else if (type === "error") iconEl.innerHTML = "&#9888;";
    else iconEl.innerHTML = "&#8505;";
  }

  alertEl.classList.remove("is-hidden");
  setTimeout(() => {
    alertEl.classList.add("is-hidden");
  }, 6500);
}

// ============================================================================
// Navigation & Views
// ============================================================================
function setView(viewName) {
  if (typeof window.setPalaestraView === "function") {
    window.setPalaestraView(viewName);
  } else {
    const landingView = document.getElementById("landing-view");
    const appView = document.getElementById("app-view");

    if (viewName === "floor") {
      if (landingView) {
        landingView.classList.remove("is-active");
        landingView.classList.add("is-hidden");
      }
      if (appView) {
        appView.classList.remove("is-hidden");
        appView.classList.add("is-active");
      }
      localStorage.setItem(STORAGE_KEYS.VIEW, "floor");
      autoRestoreWallet();
      refreshFloorCounters();
    } else {
      if (appView) {
        appView.classList.remove("is-active");
        appView.classList.add("is-hidden");
      }
      if (landingView) {
        landingView.classList.remove("is-hidden");
        landingView.classList.add("is-active");
      }
      localStorage.setItem(STORAGE_KEYS.VIEW, "book");
    }
  }
}

// Hook for external view change notifications
window.onPalaestraViewChanged = function(viewName) {
  if (viewName === "floor") {
    autoRestoreWallet();
    refreshFloorCounters();
  }
};

function setPanel(panelId) {
  const panels = document.querySelectorAll(".working-panel");
  panels.forEach(p => p.classList.remove("is-visible"));

  const target = document.getElementById(panelId);
  if (target) target.classList.add("is-visible");

  const navBtns = document.querySelectorAll(".sidebar-nav .nav-btn");
  navBtns.forEach(btn => {
    if (btn.dataset.target === panelId) {
      btn.classList.add("is-active");
    } else {
      btn.classList.remove("is-active");
    }
  });
}

// ============================================================================
// Unified UI Initialization
// ============================================================================
function initUI() {
  // #enter-floor button
  const enterFloorBtn = document.getElementById("enter-floor");
  if (enterFloorBtn) {
    enterFloorBtn.onclick = () => setView("floor");
  }

  // #back-to-book button
  const backToBookBtn = document.getElementById("back-to-book");
  if (backToBookBtn) {
    backToBookBtn.onclick = () => setView("book");
  }

  // Sidebar navigation panel buttons
  const navBtns = document.querySelectorAll(".sidebar-nav .nav-btn");
  navBtns.forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.dataset.target;
      if (targetId) setPanel(targetId);
    };
  });

  // Wallet buttons
  const connectBtn = document.getElementById("connect-wallet");
  if (connectBtn) {
    connectBtn.onclick = connectWallet;
  }

  const disconnectBtn = document.getElementById("disconnect-wallet");
  if (disconnectBtn) {
    disconnectBtn.onclick = disconnectWallet;
  }

  // Alert toast close button
  const alertClose = document.getElementById("alert-close");
  if (alertClose) {
    alertClose.onclick = () => {
      const alertEl = document.getElementById("floor-alert");
      if (alertEl) alertEl.classList.add("is-hidden");
    };
  }

  // Initialize Forms
  initOpenForm();
  initMatchForm();
  initCancelForm();
  initResolveForm();
  initTimeoutForm();
  initLookupForm();

  // Restore initial view from localStorage
  const savedView = localStorage.getItem(STORAGE_KEYS.VIEW);
  if (savedView === "floor") {
    setView("floor");
  } else {
    setView("book");
  }
}

// ============================================================================
// Form Handlers
// ============================================================================

// Form 01: #open-form
function initOpenForm() {
  const form = document.getElementById("open-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const questionInput = document.getElementById("open-question");
    const eventDateInput = document.getElementById("open-event-date");
    const resolveAfterInput = document.getElementById("open-resolve-after");
    const sideInput = form.querySelector('input[name="side"]:checked');
    const sourceAInput = document.getElementById("open-source-a");
    const sourceBInput = document.getElementById("open-source-b");
    const stakeInput = document.getElementById("open-stake");

    const question = (questionInput?.value || "").trim();
    const eventDate = (eventDateInput?.value || "").trim();
    const resolveAfter = (resolveAfterInput?.value || "").trim();
    const side = (sideInput?.value || "YES").trim().toUpperCase();
    const sourceA = (sourceAInput?.value || "").trim();
    const sourceB = (sourceBInput?.value || "").trim();
    const stakeRaw = (stakeInput?.value || "").trim();

    if (question.length < 12) {
      showAlert("Question must be at least 12 characters long.", "error");
      questionInput?.focus();
      return;
    }

    const vDateEvent = validateDateString(eventDate, "Event date");
    if (!vDateEvent.valid) {
      showAlert(vDateEvent.error, "error");
      eventDateInput?.focus();
      return;
    }
    const vDateResolve = validateDateString(resolveAfter, "Resolve after date");
    if (!vDateResolve.valid) {
      showAlert(vDateResolve.error, "error");
      resolveAfterInput?.focus();
      return;
    }
    if (resolveAfter < eventDate) {
      showAlert("Resolve after date must be on or after event date.", "error");
      resolveAfterInput?.focus();
      return;
    }

    if (side !== "YES" && side !== "NO") {
      showAlert("Side must be YES or NO.", "error");
      return;
    }

    const vUrls = validateUrls(sourceA, sourceB);
    if (!vUrls.valid) {
      showAlert(vUrls.error, "error");
      return;
    }

    let stakeWei;
    try {
      stakeWei = parseGenToWei(stakeRaw);
    } catch (err) {
      showAlert(err.message, "error");
      stakeInput?.focus();
      return;
    }

    try {
      const txHash = await executeContractWrite(
        "create_wager",
        [question, eventDate, resolveAfter, side, sourceA, sourceB],
        stakeWei,
        "Opening New Contest"
      );

      if (txHash) {
        form.reset();
        await refreshFloorCounters();
        const count = await callContractView("get_wager_count");
        showAlert(`Contest opened successfully! ID: #${count}`, "success");
      }
    } catch (err) {
      console.error("Error creating wager:", err);
    }
  });
}

// Form 02: #match-form
function initMatchForm() {
  const form = document.getElementById("match-form");
  const previewBtn = document.getElementById("btn-match-preview");
  if (!form) return;

  if (previewBtn) {
    previewBtn.addEventListener("click", async () => {
      const wagerIdInput = document.getElementById("match-wager-id");
      const wagerId = (wagerIdInput?.value || "").trim();
      if (!wagerId) {
        showAlert("Please enter a Contest ID to inspect.", "error");
        wagerIdInput?.focus();
        return;
      }

      try {
        const raw = await callContractView("get_wager", [wagerId]);
        if (!raw) {
          showAlert(`Contest #${wagerId} not found.`, "error");
          return;
        }
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;

        const container = document.getElementById("match-preview-container");
        const statusEl = document.getElementById("match-preview-status");
        const questionEl = document.getElementById("match-preview-question");
        const creatorEl = document.getElementById("match-preview-creator");
        const sideEl = document.getElementById("match-preview-side");
        const counterEl = document.getElementById("match-preview-counter");
        const stakeEl = document.getElementById("match-preview-stake");
        const stakeInput = document.getElementById("match-stake");

        if (container) container.classList.remove("is-hidden");
        if (statusEl) {
          statusEl.textContent = data.status;
          statusEl.className = `status-chip chip-${data.status.toLowerCase()}`;
        }
        if (questionEl) questionEl.textContent = `"${data.question}"`;
        if (creatorEl) creatorEl.textContent = shortenAddress(data.creator);
        if (sideEl) sideEl.textContent = data.creator_side;
        if (counterEl) counterEl.textContent = data.creator_side === "YES" ? "NO" : "YES";

        const formattedGen = formatWeiToGen(data.stake);
        if (stakeEl) stakeEl.textContent = formattedGen;

        if (stakeInput) {
          const pureGenNum = formattedGen.replace(" GEN", "");
          stakeInput.value = pureGenNum;
        }

        showAlert(`Loaded Contest #${wagerId} details. Required stake: ${formattedGen}`, "info");
      } catch (err) {
        console.error("Match preview error:", err);
        showAlert(err.message || "Failed to fetch contest details.", "error");
      }
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const wagerIdInput = document.getElementById("match-wager-id");
    const stakeInput = document.getElementById("match-stake");

    const wagerId = (wagerIdInput?.value || "").trim();
    const stakeRaw = (stakeInput?.value || "").trim();

    if (!wagerId) {
      showAlert("Contest ID is required.", "error");
      wagerIdInput?.focus();
      return;
    }

    let stakeWei;
    try {
      stakeWei = parseGenToWei(stakeRaw);
    } catch (err) {
      showAlert(err.message, "error");
      stakeInput?.focus();
      return;
    }

    try {
      const txHash = await executeContractWrite(
        "join",
        [wagerId],
        stakeWei,
        `Matching Contest #${wagerId}`
      );

      if (txHash) {
        form.reset();
        const previewBox = document.getElementById("match-preview-container");
        if (previewBox) previewBox.classList.add("is-hidden");
        await refreshFloorCounters();
        showAlert(`Successfully matched Contest #${wagerId}!`, "success");
      }
    } catch (err) {
      console.error("Error matching wager:", err);
    }
  });
}

// Form 03: #cancel-form
function initCancelForm() {
  const form = document.getElementById("cancel-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const wagerIdInput = document.getElementById("cancel-wager-id");
    const wagerId = (wagerIdInput?.value || "").trim();

    if (!wagerId) {
      showAlert("Contest ID is required to cancel.", "error");
      wagerIdInput?.focus();
      return;
    }

    try {
      const txHash = await executeContractWrite(
        "cancel",
        [wagerId],
        0n,
        `Cancelling Contest #${wagerId}`
      );

      if (txHash) {
        form.reset();
        await refreshFloorCounters();
        showAlert(`Contest #${wagerId} has been cancelled and creator stake refunded.`, "success");
      }
    } catch (err) {
      console.error("Error cancelling wager:", err);
    }
  });
}

// Form 04: #resolve-form (Settle / Resolve)
function initResolveForm() {
  const form = document.getElementById("resolve-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const wagerIdInput = document.getElementById("resolve-wager-id");
    const wagerId = (wagerIdInput?.value || "").trim();

    if (!wagerId) {
      showAlert("Contest ID is required to resolve.", "error");
      wagerIdInput?.focus();
      return;
    }

    try {
      const txHash = await executeContractWrite(
        "resolve",
        [wagerId],
        0n,
        `Resolving Contest #${wagerId}`
      );

      if (txHash) {
        form.reset();
        const raw = await callContractView("get_wager", [wagerId], "ACCEPTED");
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;

        const resBox = document.getElementById("resolve-result-box");
        const chipEl = document.getElementById("resolve-status-chip");
        const statusEl = document.getElementById("resolve-res-status");
        const verdictEl = document.getElementById("resolve-res-verdict");
        const fundsEl = document.getElementById("resolve-res-funds");
        const noteEl = document.getElementById("resolve-res-note");

        if (resBox) resBox.classList.remove("is-hidden");
        if (chipEl) {
          chipEl.textContent = data.status;
          chipEl.className = `status-chip chip-${data.status.toLowerCase()}`;
        }
        if (statusEl) statusEl.textContent = data.status;
        if (verdictEl) verdictEl.textContent = data.verdict || "—";
        if (fundsEl) fundsEl.textContent = data.funds_disposition;

        if (noteEl) {
          if (data.status === "SETTLED") {
            noteEl.textContent = `Contest settled with verdict: ${data.verdict}. Pot paid to winner.`;
          } else {
            noteEl.textContent = `Consensus was ${data.verdict || "UNKNOWN"}. The contest remains MATCHED. Stakes may be returned via timeout after refund_after.`;
          }
        }

        showAlert(`Contest #${wagerId} adjudicated: ${data.status}`, "success");
      }
    } catch (err) {
      console.error("Error resolving wager:", err);
    }
  });
}

// Form 05: #timeout-form (Return both stakes)
function initTimeoutForm() {
  const form = document.getElementById("timeout-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const wagerIdInput = document.getElementById("timeout-wager-id");
    const wagerId = (wagerIdInput?.value || "").trim();

    if (!wagerId) {
      showAlert("Contest ID is required for timeout refund.", "error");
      wagerIdInput?.focus();
      return;
    }

    try {
      const txHash = await executeContractWrite(
        "timeout_refund",
        [wagerId],
        0n,
        `Returning Both Stakes for Contest #${wagerId}`
      );

      if (txHash) {
        form.reset();
        await refreshFloorCounters();
        showAlert(`Both stakes for Contest #${wagerId} have been refunded.`, "success");
      }
    } catch (err) {
      console.error("Error with timeout refund:", err);
    }
  });
}

// Form 06: #lookup-form (get_wager & can_resolve)
function initLookupForm() {
  const form = document.getElementById("lookup-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const wagerIdInput = document.getElementById("lookup-wager-id");
    const wagerId = (wagerIdInput?.value || "").trim();

    if (!wagerId) {
      showAlert("Please enter a Contest ID to lookup.", "error");
      wagerIdInput?.focus();
      return;
    }

    try {
      const rawWager = await callContractView("get_wager", [wagerId], "ACCEPTED");
      if (!rawWager) {
        showAlert(`Contest #${wagerId} does not exist.`, "error");
        return;
      }

      const wagerData = typeof rawWager === "string" ? JSON.parse(rawWager) : rawWager;
      let canData = { allowed: false, timeout_refund_allowed: false };

      try {
        const rawCan = await callContractView("can_resolve", [wagerId], "ACCEPTED");
        if (rawCan) {
          canData = typeof rawCan === "string" ? JSON.parse(rawCan) : rawCan;
        }
      } catch (err) {
        console.warn("can_resolve check failed:", err);
      }

      renderLookupTicket(wagerId, wagerData, canData);
      showAlert(`Loaded Contest #${wagerId} details.`, "success");
    } catch (err) {
      console.error("Lookup error:", err);
      showAlert(`Lookup failed: ${err.message || err}`, "error");
    }
  });
}

function renderLookupTicket(wagerId, wager, can) {
  const emptyState = document.getElementById("lookup-empty-state");
  const resultWrap = document.getElementById("lookup-result-wrap");

  if (emptyState) emptyState.classList.add("is-hidden");
  if (resultWrap) resultWrap.classList.remove("is-hidden");

  // Header
  const idEl = document.getElementById("lookup-display-id");
  const nowEl = document.getElementById("lookup-display-now");
  const statusEl = document.getElementById("lookup-display-status");

  if (idEl) idEl.textContent = `CONTEST #${wagerId}`;
  if (nowEl) nowEl.textContent = `UTC NOW: ${can.current_date || new Date().toISOString().slice(0, 10)}`;
  if (statusEl) {
    statusEl.textContent = wager.status;
    statusEl.className = `status-chip chip-${wager.status.toLowerCase()} font-mono`;
  }

  // Left Column
  const qEl = document.getElementById("lookup-display-question");
  const creatorEl = document.getElementById("lookup-display-creator");
  const joinerEl = document.getElementById("lookup-display-joiner");
  const eventDateEl = document.getElementById("lookup-display-event-date");
  const resolveAfterEl = document.getElementById("lookup-display-resolve-after");
  const refundAfterEl = document.getElementById("lookup-display-refund-after");

  if (qEl) qEl.textContent = `"${wager.question}"`;
  if (creatorEl) creatorEl.textContent = shortenAddress(wager.creator);
  if (joinerEl) joinerEl.textContent = wager.joiner ? shortenAddress(wager.joiner) : "(none / open)";
  if (eventDateEl) eventDateEl.textContent = wager.event_date;
  if (resolveAfterEl) resolveAfterEl.textContent = wager.resolve_after;
  if (refundAfterEl) refundAfterEl.textContent = wager.refund_after;

  // Sources
  const hostAEl = document.getElementById("lookup-display-host-a");
  const urlAEl = document.getElementById("lookup-display-source-a");
  const hostBEl = document.getElementById("lookup-display-host-b");
  const urlBEl = document.getElementById("lookup-display-source-b");

  try {
    const parsedA = new URL(wager.source_url_a);
    if (hostAEl) hostAEl.textContent = parsedA.hostname;
    if (urlAEl) {
      urlAEl.href = wager.source_url_a;
      urlAEl.textContent = wager.source_url_a;
    }
  } catch (e) {
    if (urlAEl) {
      urlAEl.href = "#";
      urlAEl.textContent = wager.source_url_a;
    }
  }

  try {
    const parsedB = new URL(wager.source_url_b);
    if (hostBEl) hostBEl.textContent = parsedB.hostname;
    if (urlBEl) {
      urlBEl.href = wager.source_url_b;
      urlBEl.textContent = wager.source_url_b;
    }
  } catch (e) {
    if (urlBEl) {
      urlBEl.href = "#";
      urlBEl.textContent = wager.source_url_b;
    }
  }

  // Right Column
  const stakeEl = document.getElementById("lookup-display-stake");
  const potEl = document.getElementById("lookup-display-pot");
  const sideEl = document.getElementById("lookup-display-creator-side");
  const verdictEl = document.getElementById("lookup-display-verdict");
  const fundsEl = document.getElementById("lookup-display-funds");
  const allowedEl = document.getElementById("lookup-display-allowed");
  const timeoutAllowedEl = document.getElementById("lookup-display-timeout-allowed");

  const singleStake = formatWeiToGen(wager.stake);
  const doubleStakeWei = BigInt(wager.stake || "0") * 2n;
  const doubleStake = formatWeiToGen(doubleStakeWei);

  if (stakeEl) stakeEl.textContent = singleStake;
  if (potEl) potEl.textContent = `Matched Pot: ${doubleStake}`;
  if (sideEl) {
    sideEl.textContent = wager.creator_side;
    sideEl.className = `side-pick font-mono side-${wager.creator_side.toLowerCase()}`;
  }
  if (verdictEl) verdictEl.textContent = wager.verdict || "(pending)";
  if (fundsEl) fundsEl.textContent = wager.funds_disposition;
  if (allowedEl) allowedEl.textContent = can.allowed ? "YES (Callable Now)" : "NO";
  if (timeoutAllowedEl) timeoutAllowedEl.textContent = can.timeout_refund_allowed ? "YES (Callable Now)" : "NO";

  // Action shortcuts
  const matchAction = document.getElementById("lookup-action-match");
  const resolveAction = document.getElementById("lookup-action-resolve");
  const refundAction = document.getElementById("lookup-action-refund");

  if (matchAction) {
    if (wager.status === "OPEN") {
      matchAction.classList.remove("is-hidden");
      matchAction.onclick = () => {
        setPanel("panel-match");
        const matchIdInput = document.getElementById("match-wager-id");
        const matchStakeInput = document.getElementById("match-stake");
        if (matchIdInput) matchIdInput.value = wagerId;
        if (matchStakeInput) matchStakeInput.value = singleStake.replace(" GEN", "");
      };
    } else {
      matchAction.classList.add("is-hidden");
    }
  }

  if (resolveAction) {
    if (wager.status === "MATCHED" && can.allowed) {
      resolveAction.classList.remove("is-hidden");
      resolveAction.onclick = () => {
        setPanel("panel-resolve");
        const resIdInput = document.getElementById("resolve-wager-id");
        if (resIdInput) resIdInput.value = wagerId;
      };
    } else {
      resolveAction.classList.add("is-hidden");
    }
  }

  if (refundAction) {
    if (wager.status === "MATCHED" && can.timeout_refund_allowed) {
      refundAction.classList.remove("is-hidden");
      refundAction.onclick = () => {
        setPanel("panel-resolve");
        const timeoutIdInput = document.getElementById("timeout-wager-id");
        if (timeoutIdInput) timeoutIdInput.value = wagerId;
      };
    } else {
      refundAction.classList.add("is-hidden");
    }
  }
}

// ============================================================================
// Immediate DOM & EIP-6963 Ready Initialization
// ============================================================================
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initEip6963();
    initUI();
  });
} else {
  initEip6963();
  initUI();
}
