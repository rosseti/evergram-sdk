export interface Question {
  question: string;
  answer: string;
}

// A handful of sample rounds about the XRPL/Xahau/Evernode ecosystem that
// Evergram itself runs on — swap this for a real question bank (a file, a
// database, an API) in anything beyond a demo.
export const QUESTIONS: Question[] = [
  {
    question: "What consensus algorithm does the XRP Ledger use?",
    answer: "XRPL Consensus Protocol",
  },
  { question: "What is the native token of the Xahau Network called?", answer: "XAH" },
  {
    question: "What do you call a host machine that leases compute to Evernode instances?",
    answer: "host",
  },
  {
    question: "What smart contract technology does Xahau add on top of the XRPL codebase?",
    answer: "Hooks",
  },
  {
    question: "What is Evergram's smart contract layer built on, running as an Evernode instance?",
    answer: "HotPocket",
  },
  {
    question: "What XRPL primitive lets an issuer freeze or restrict a token?",
    answer: "trust line",
  },
  {
    question: "What is the unit of currency leased for hosting on Evernode called?",
    answer: "EVR",
  },
  {
    question: "What language are XRPL Hooks written in before compiling to WebAssembly?",
    answer: "C",
  },
  {
    question: "What consensus algorithm family does the XRPL Consensus Protocol belong to?",
    answer: "Federated Byzantine Agreement",
  },
  { question: "Which XLS standard defines NFTs on the XRP Ledger?", answer: "XLS-20" },
  {
    question: "What XRPL feature lets you lock XRP until a time or condition is met?",
    answer: "Escrow",
  },
  {
    question: "What software do Evernode hosts run to manage their leased instances?",
    answer: "Sashimono",
  },
  {
    question: "What do you call the time unit Evernode uses to measure a lease's duration?",
    answer: "moment",
  },
  {
    question: "What type of token represents an Evernode host registration or lease?",
    answer: "URIToken",
  },
  {
    question: "What do XRPL Hooks compile down to before running on Xahau?",
    answer: "WebAssembly",
  },
  {
    question: "What is the XRP Ledger's built-in decentralized exchange feature called?",
    answer: "DEX",
  },
  { question: "What is the ticker symbol for the XRP Ledger's native asset?", answer: "XRP" },
  {
    question: "What do you call an XRPL account that issues a non-XRP currency?",
    answer: "issuer",
  },
  { question: "What happens to the XRP paid as XRPL network transaction fees?", answer: "burned" },
  {
    question:
      "What XRPL feature enables high-throughput, off-ledger streaming payments settled on-chain?",
    answer: "Payment Channels",
  },
  {
    question: "What XRPL object type represents a deferred, cashable payment authorization?",
    answer: "Check",
  },
  {
    question: "What XRPL feature lets an account require multiple keys to authorize a transaction?",
    answer: "Multi-signing",
  },
  {
    question:
      "What is the name for a candidate protocol upgrade that XRPL validators vote to activate?",
    answer: "Amendment",
  },
  {
    question: "What is the reference server implementation of the XRP Ledger protocol called?",
    answer: "rippled",
  },
  {
    question:
      "What is the name of the native liquidity-pool feature added to the XRPL via amendment?",
    answer: "AMM",
  },
  {
    question:
      "What XRPL amendment lets an issuer reclaim tokens it issued from a holder's account?",
    answer: "Clawback",
  },
  {
    question: "In XRPL terms, what is the minimum XRP balance an account must hold called?",
    answer: "reserve",
  },
  {
    question:
      "What protocol do XRPL clients typically use to submit transactions and subscribe to ledger updates in real time?",
    answer: "WebSocket",
  },
  {
    question:
      "What optional numeric field lets one XRPL account distinguish payments meant for different sub-accounts, e.g. on an exchange?",
    answer: "Destination Tag",
  },
  { question: "What year did the XRP Ledger go live?", answer: "2012" },
  { question: "What company originally created the XRP Ledger?", answer: "Ripple" },
  {
    question: "What is the reference node software for the Xahau Network called?",
    answer: "xahaud",
  },
];
