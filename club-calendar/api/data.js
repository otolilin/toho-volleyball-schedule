const crypto = require("crypto");
const U = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const T = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = async (cmd) => {
  const r = await fetch(U, { method: "POST", headers: { Authorization: "Bearer " + T }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
};
const same = (a, b) => {
  if (!a || !b) return false;
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const TIME = /^\d\d:\d\d$/, DATE = /^\d{4}-\d\d-\d\d$/, STATUS = ["in", "late", "early", "out"];

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {};
  const level = same(b.admin, process.env.ADMIN_PASSWORD) ? 2 : same(b.code, process.env.MEMBER_CODE) ? 1 : 0;
  try {
    let cfg = JSON.parse((await redis(["GET", "club:cfg"])) || "null") || { days: {}, members: [], ds: "17:00", de: "19:00" };

    if (b.a === "save") {
      if (level < 2) return res.status(401).json({ error: "auth" });
      const c = b.cfg || {}, days = {};
      for (const [k, v] of Object.entries(c.days || {})) {
        if (DATE.test(k) && v && TIME.test(v.s) && TIME.test(v.e)) days[k] = { s: v.s, e: v.e };
      }
      const members = (c.members || []).slice(0, 100)
        .map((m) => ({ id: String(m.id).slice(0, 30), name: String(m.name).slice(0, 30) }));
      cfg = { days, members, ds: TIME.test(c.ds) ? c.ds : "17:00", de: TIME.test(c.de) ? c.de : "19:00" };
      await redis(["SET", "club:cfg", JSON.stringify(cfg)]);
    }

    if (b.a === "vote") {
      if (level < 1) return res.status(401).json({ error: "auth" });
      if (!cfg.members.some((m) => m.id === b.me) || !cfg.days[b.date]) return res.status(400).json({ error: "bad" });
      const cur = JSON.parse((await redis(["HGET", "club:votes", b.me])) || "{}");
      if (STATUS.includes(b.s)) cur[b.date] = { s: b.s, r: String(b.r || "").slice(0, 100) };
      else delete cur[b.date];
      await redis(["HSET", "club:votes", b.me, JSON.stringify(cur)]);
    }

    const out = { level, cfg: { days: cfg.days, ds: cfg.ds, de: cfg.de } };
    if (level >= 1) {
      const flat = (await redis(["HGETALL", "club:votes"])) || [];
      const votes = {};
      for (let i = 0; i < flat.length; i += 2) votes[flat[i]] = JSON.parse(flat[i + 1]);
      const counts = {};
      for (const d of Object.keys(cfg.days)) counts[d] = { in: 0, late: 0, early: 0, out: 0 };
      for (const v of Object.values(votes)) for (const [d, x] of Object.entries(v)) if (counts[d] && counts[d][x.s] !== undefined) counts[d][x.s]++;
      out.members = cfg.members;
      out.counts = counts;
      out.mine = votes[b.me] || {};
      if (level === 2) out.votes = votes;
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: "server" });
  }
};
