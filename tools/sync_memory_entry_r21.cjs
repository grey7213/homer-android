// Mechanical mirror of the source readiness change in the checked-in Bun bundle.
const fs=require('node:fs');const file='sillytavern-runtime/public/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js';let s=fs.readFileSync(file,'utf8');
const at=s.indexOf('window.HomerMemoryBooks=');if(at<0)throw Error('ready export absent');
const before=s.slice(0,at),matches=[...before.matchAll(/function ([\w$]+)\(\)\{/g)],m=matches.at(-1);if(!m)throw Error('ready function absent');
const token='function '+m[1]+'(){';if(!s.includes(token+'if(window.HomerMemoryBooks?.open)'))s=s.replace(token,token+'if(window.HomerMemoryBooks?.open)return;');
 s=s.replace(token+'if(window.HomerMemoryBooks?.open)return;',token+'if(window.HomerMemoryBooks?.open){document.querySelector("#stmb-menu-item")?.setAttribute("data-homer-ready","true");return;}');
const init='console.log("STMemoryBooks: Initializing");';if(!s.includes(init))throw Error('init anchor absent');if(!s.includes(init+m[1]+'();'))s=s.replace(init,init+m[1]+'();');
fs.writeFileSync(file,s);console.log('Source readiness order mirrored in bundled Memory Books.');
