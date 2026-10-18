// Dev-time script: public/index.html theke Tailwind class gulo khuje static public/app.css toiri kore.
// Run: node tools/build-css.mjs   (tailwindcss v4 package lagbe; shudhu developer-er jonno, server-e lagbe na)
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const twDir = path.dirname(require.resolve('tailwindcss/package.json', { paths: [process.cwd(), '/opt/npm-tools/node_modules'] }));
const { compile } = await import(path.join(twDir, 'dist/lib.mjs'));
const html = fs.readFileSync('public/index.html', 'utf8');
const cands = new Set([...(html.match(/[A-Za-z0-9_\-:/.\[\]#%!()',@=&>*+~]+/g) || []), ...(html.match(/[^\s"'`<>=,;{}]+/g) || [])]);
const input = `
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
@theme {
  --color-tg-bg:#0e1621; --color-tg-sidebar:#17212b; --color-tg-header:#17212b; --color-tg-inputBg:#242f3d;
  --color-tg-accent:#2aabee; --color-tg-accentHover:#229ed9; --color-tg-bubbleSent:#2b5278; --color-tg-bubbleRecv:#182533; --color-tg-subtext:#7f91a4;
}
@layer base { *, ::after, ::before, ::backdrop, ::file-selector-button { border-color: var(--color-gray-200, currentColor); } button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; } }
`;
const compiler = await compile(input, {
  base: twDir,
  loadStylesheet: async (id, base) => {
    let p;
    if (id === 'tailwindcss') p = path.join(twDir, 'index.css');
    else if (id.startsWith('tailwindcss/')) p = path.join(twDir, id.slice('tailwindcss/'.length));
    else p = path.resolve(base, id);
    return { path: p, base: path.dirname(p), content: fs.readFileSync(p, 'utf8') };
  }
});
const css = compiler.build([...cands]);
fs.writeFileSync('public/app.css', css);
console.log('app.css', css.length, 'bytes');
