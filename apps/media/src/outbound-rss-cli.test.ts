import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native RSS CLI rejects a private destination without leaking the URL or backend credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(),"narriflow-outbound-cli-"));
  const outputPath = join(directory,"feed.json");
  try {
    const child = Bun.spawn([process.execPath,new URL("./outbound-rss-cli.ts",import.meta.url).pathname],{
      stdin:"pipe",stdout:"pipe",stderr:"pipe",env:{...process.env,DATABASE_URL:"postgres://poison.invalid/never",DIRECT_URL:"postgres://poison.invalid/never",UPSTASH_REDIS_REST_URL:"https://poison.invalid/never"},
    });
    child.stdin.write(JSON.stringify({input:{kind:"rss_feed",url:"http://127.0.0.1/private-token-NEVER-LOG",etag:null,lastModified:null},outputPath}));child.stdin.end();
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(code).toBe(1);expect(stdout).toBe("");expect(JSON.parse(stderr)).toMatchObject({errorCode:"remote_url_unsafe"});
    expect(stderr).not.toContain("private-token");expect(stderr).not.toContain("poison.invalid");
    expect(await stat(outputPath).then(()=>true,()=>false)).toBe(false);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
