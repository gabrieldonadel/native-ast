const fs=require('fs');
const FIX=process.env.HOME+'/Developer/expo/packages/install-expo-modules/src/plugins/ios/__tests__/fixtures/AppDelegate-rn083.swift';
const src=fs.readFileSync(FIX,'utf8');
const ms=(a,b)=>(Number(b-a)/1e6).toFixed(1);
(async()=>{
  { const t0=process.hrtime.bigint();
    const P=require('tree-sitter'), S=require('tree-sitter-swift');
    const t1=process.hrtime.bigint();
    const p=new P(); p.setLanguage(S);
    const t2=process.hrtime.bigint(); p.parse(src); const t3=process.hrtime.bigint();
    console.log(`native: require ${ms(t0,t1)}ms  setLanguage ${ms(t1,t2)}ms  first parse ${ms(t2,t3)}ms  total ${ms(t0,t3)}ms`); }
  { const t0=process.hrtime.bigint();
    const {Parser,Language}=require('web-tree-sitter');
    await Parser.init();
    const t1=process.hrtime.bigint();
    const p=new Parser(); p.setLanguage(await Language.load('./tree-sitter-swift.wasm'));
    const t2=process.hrtime.bigint(); p.parse(src); const t3=process.hrtime.bigint();
    console.log(`wasm:   require+init ${ms(t0,t1)}ms  load lang ${ms(t1,t2)}ms  first parse ${ms(t2,t3)}ms  total ${ms(t0,t3)}ms`); }
})();
