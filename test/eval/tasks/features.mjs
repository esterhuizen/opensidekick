// Questions about OpenSidekick itself: its settings, local models, privacy.

import { affirmed } from "../lib/check.mjs";

export default [
  {
    id: "feat-stop-asking",
    category: "features",
    start: "https://shop.test/",
    turns: ["how do i make you stop asking permission all the time"],
    check: (r) => {
      const a = r.answer;
      if (/(not possible|can'?t be (changed|turned off)|no way to|\bno (?:auto|setting|option|switch)\b|(?:have|need) to approve (?:each|every))/i.test(a)) return { score: 0, wrong: true, why: "claims it can't be changed" };
      if ((affirmed(a, /\bauto\b/i) && /approval|autonomy|mode|selector/i.test(a)) || affirmed(a, /always allow/i) || affirmed(a, /don'?t ask|act without asking/i)) return { score: 1, why: "Auto approval or Always allow named" };
      if (/settings?/i.test(a) && /permission|approv|ask/i.test(a)) return { score: 0.5, why: "points at settings, no specific switch" };
      return { score: 0, why: "no way to stop the prompts given" };
    },
    fake: { oracle: [[["finish", "Switch Approval to Auto in the side panel, or choose Always allow this site on the card."]]] },
  },
  {
    id: "feat-ollama",
    category: "features",
    start: "newtab",
    turns: ["can i use you with ollama on my laptop?"],
    check: (r) => {
      const a = r.answer;
      // "can't connect to Ollama unless you set OLLAMA_ORIGINS" is the right answer, not a no.
      if (affirmed(a, /(doesn'?t|does not|can'?t|cannot)\s+(work|support|use|connect)[^.]{0,30}?ollama|ollama[^.]{0,30}(isn'?t|is not|not)\s+supported/i, { after: true })) return { score: 0, wrong: true, why: "says Ollama isn't supported" };
      if (/ollama/i.test(a) && /OLLAMA_ORIGINS/.test(a)) return { score: 1, why: "yes, with OLLAMA_ORIGINS" };
      if (/\byes\b|you can/i.test(a) && /settings|preset|11434/i.test(a)) return { score: 0.5, why: "yes, without the OLLAMA_ORIGINS step" };
      return { score: 0, why: "no usable answer" };
    },
    fake: { oracle: [[["finish", "Yes: pick the Ollama preset in Settings and set OLLAMA_ORIGINS=chrome-extension://* before starting Ollama."]]] },
  },
  {
    id: "feat-history-privacy",
    category: "features",
    start: "https://news.test/2026/11/bridge-vote",
    turns: ["are my chats with you saved anywhere? do they get sent to a server?"],
    check: (r) => {
      const a = r.answer;
      if (affirmed(a, /(stored|saved|kept)\s+(on|in)\s+(our|opensidekick'?s?|the cloud|a server)/i)) return { score: 0, wrong: true, why: "claims chats are stored on a server" };
      if (/(locally|on (your|this) (device|computer)|in (your|this) browser|chrome\.storage)/i.test(a)) return { score: 1, why: "says chats stay on the device" };
      return { score: 0, why: "doesn't say where chats are kept" };
    },
    fake: { oracle: [[["finish", "They stay locally in this browser (chrome.storage.local); nothing goes to an OpenSidekick server. Only the model provider you chose sees the messages."]]] },
  },
];
