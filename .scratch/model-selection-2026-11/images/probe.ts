const key = (await Bun.file(process.argv[2]!).text()).trim();
const prompt = "Editorial documentary photography, natural light: a street food vendor in Lahore at dusk, steam rising from a wok. No text or watermark.";
for (const model of ["gpt-image-2", "gpt-image-2.6-flare", "gpt-image-2.5-flare"]) {
  const t = Date.now();
  const r = await fetch("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: "1024x1536", quality: "medium", n: 1 }) });
  const j: any = await r.json();
  const ms = Date.now() - t;
  if (!r.ok) { console.log(model, r.status, JSON.stringify(j.error).slice(0, 300)); continue; }
  const b64 = j.data?.[0]?.b64_json; if (b64) await Bun.write(`${import.meta.dir}/${model}.png`, Buffer.from(b64, "base64"));
  const u = j.usage; const out = u?.output_tokens ?? 0, inT = u?.input_tokens_details?.text_tokens ?? u?.input_tokens ?? 0;
  console.log(model, `${ms}ms`, JSON.stringify(u), `cost≈$${((out * 30 + inT * 5) / 1e6).toFixed(4)}`);
}
