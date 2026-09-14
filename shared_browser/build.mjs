import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["recorder.js"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "dist/recorder.js",
});
await build({
  entryPoints: ["viewer.js"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "dist/viewer.js",
});
let html = await readFile("viewer.html", "utf8");
for (const name of ["viewer.js", "viewer.css"]) {
  const hash = createHash("sha256")
    .update(await readFile("dist/" + name))
    .digest("hex")
    .slice(0, 16);
  html = html.replace("/" + name, "/" + name + "?v=" + hash);
}
await writeFile("dist/viewer.html", html);
await copyFile("fixture.html", "dist/fixture.html");
await build({entryPoints:['passkey-phone.js'],bundle:true,minify:true,format:'iife',outfile:'dist/passkey-phone.js'});
for (const name of ['passkey-phone.html','passkey-site.html','passkey-site.js']) await copyFile(name, 'dist/'+name);
await build({entryPoints:['portal-passkey-client.js'],bundle:true,minify:true,format:'iife',outfile:'dist/portal-passkey-client.js'});
await copyFile('portal-passkey.html','dist/portal-passkey.html');
