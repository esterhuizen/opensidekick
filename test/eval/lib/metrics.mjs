// Per-run friction and cost metrics (design §7.4). Pure over a RunRecord.

export function metrics(record) {
  const ev = record.events || [];
  const count = (kind) => ev.filter((e) => e.kind === kind).length;
  const tools = {};
  for (const e of ev) if (e.kind === "tool_start") tools[e.name] = (tools[e.name] || 0) + 1;
  const cards = record.cards || [];
  const sensitive = cards.filter((c) => c.sensitive).length;
  const qs = record.questions || [];
  const calls = (record.proxy?.calls || []).filter((c) => !c.probe);
  return {
    turns: (record.turns || []).length,
    steps: count("assistant_start"),
    toolCalls: count("tool_start"),
    tools,
    cards: { total: cards.length, gate: cards.length - sensitive, sensitive, declined: cards.filter((c) => c.choice === "decline").length },
    checkpoints: (record.checkpoints || []).length,
    questions: {
      total: qs.length,
      viaTool: qs.filter((q) => q.via === "tool").length,
      viaText: qs.filter((q) => q.via === "text").length,
      unnecessary: qs.filter((q) => !q.expected).length,
    },
    loopWarnings: ev.filter((e) => e.kind === "tool_end" && /^skipped: repeated/.test(e.summary || "")).length,
    injectionFlagged: ev.some((e) => e.kind === "warning" && /^Possible prompt injection/.test(e.text || "")),
    wallMs: (record.turns || []).reduce((s, t) => s + Math.max(0, (t.endedAt || t.sentAt) - t.sentAt), 0),
    backoffMs: calls.reduce((s, c) => s + (c.backoffMs || 0), 0),
  };
}

// Token totals from the proxy log, or null when no call reported usage.
export function tokens(record) {
  const calls = (record.proxy?.calls || []).filter((c) => !c.probe);
  const withUsage = calls.filter((c) => c.usage);
  if (!withUsage.length) return null;
  const sum = (k) => withUsage.reduce((s, c) => s + (c.usage[k] || 0), 0);
  return { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), calls: calls.length };
}

export function providerStats(record) {
  const calls = (record.proxy?.calls || []).filter((c) => !c.probe);
  return {
    calls: calls.length,
    retries: calls.reduce((s, c) => s + (c.retries || 0), 0),
    errors: calls.filter((c) => c.status >= 400 || c.status === 0).map((c) => ({ status: c.status, snippet: c.errorSnippet || "" })),
  };
}
