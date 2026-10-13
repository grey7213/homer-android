// Bounded mechanical update to the shipped message components, not script frames.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const file=new URL('../sillytavern-runtime/public/scripts/extensions/third-party/js-slash-runner/dist/index.js',import.meta.url);
const source=fs.readFileSync(file,'utf8');
const before='loading:`lazy`},r.src_prop';
const after='loading:document.documentElement.classList.contains(`homer-embedded-runtime`)?`eager`:`lazy`},r.src_prop';
let updated=source;
if(source.includes(before)){
    assert.equal(source.split(before).length-1,2,'Exactly the two actual message components');
    updated=source.replaceAll(before,after);
}else assert.equal(source.split(after).length-1,2,'Existing exact message loading change');
const anchor='var NI=MI(`global`),PI=MI(`character`),FI=MI(`preset`);';
assert.equal(updated.split(anchor).length-1,1,'Exact shipping character-script store');
const activation='window.HomerTavernHelperActivation={async activateCharacter(name){if(!document.documentElement.classList.contains(`homer-embedded-runtime`))return false;const store=PI();if(!name||store.source!==name)return false;store.enabled=true;await Ma();return store.source===name&&store.enabled===true}};';
const completeActivation='window.HomerTavernHelperActivation={async prepareCharacter(name){if(!name||!document.documentElement.classList.contains(`homer-embedded-runtime`))return false;const names=MF().settings.script.enabled.characters;if(!names.includes(name))names.push(name);await Ma();return names.includes(name)},async activateCharacter(name){if(!document.documentElement.classList.contains(`homer-embedded-runtime`))return false;const store=PI();if(!name||store.source!==name)return false;store.enabled=true;await Ma();return store.source===name&&store.enabled===true}};';
const readyActivation=completeActivation.replace('store.enabled=true;await Ma();','if(!store.enabled)store.enabled=true;await Ma();');
if(updated.includes(activation))updated=updated.replace(activation,readyActivation);
else if(updated.includes(completeActivation))updated=updated.replace(completeActivation,readyActivation);
else if(!updated.includes(readyActivation))updated=updated.replace(anchor,anchor+readyActivation);
const fontsImport='import{deferRemoteFontStylesheets}from"../../../../../scripts/homer-async-fonts.mjs";';
if(!updated.startsWith(fontsImport))updated=fontsImport+updated;
for(const args of ['source,n.useBlobUrl','n.srcdoc,n.useBlobUrl']){
    const plain='let t=b1('+args+');return n.useBlobUrl';
    const deferred='let t=deferRemoteFontStylesheets(b1('+args+'),document.documentElement.classList.contains(`homer-embedded-runtime`));return n.useBlobUrl';
    if(updated.includes(plain)){assert.equal(updated.split(plain).length-1,1);updated=updated.replace(plain,deferred);}
    else assert.equal(updated.split(deferred).length-1,1,'Exact message-only font deferral');
}
fs.writeFileSync(file,updated);
console.log('Embedded eager messages and exact selected-script store activation wired; non-embedded behavior preserved');
