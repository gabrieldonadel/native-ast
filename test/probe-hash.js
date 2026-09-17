const NativeParser=require('tree-sitter'), NativeSwift=require('tree-sitter-swift');
const { Parser, Language } = require('web-tree-sitter');
const cases = {
  'directive top level': '#if canImport(UIKit)\nimport UIKit\n#endif\n',
  'macro invocation':    'let x = #expect(a == b)\n',
  'selector':            'let s = #selector(foo)\n',
  'available':           'if #available(iOS 16, *) { print(1) }\n',
  'stmt-level if':       'func f() -> Int {\n#if DEBUG\n  return 1\n#else\n  return 2\n#endif\n}\n',
  'raw string':          'let s = #"hi"#\n',
  'try bang':            'let v = try! foo()\n',
};
(async()=>{
  const np=new NativeParser(); np.setLanguage(NativeSwift);
  await Parser.init();
  const wp=new Parser(); wp.setLanguage(await Language.load(process.argv[2]));
  let d=0;
  for(const [n,s] of Object.entries(cases)){
    const a=np.parse(s).rootNode.toString(), b=wp.parse(s).rootNode.toString();
    if(a!==b){d++;console.log(`DIFF  ${n}`);console.log('   native:',a.slice(0,140));console.log('   wasm:  ',b.slice(0,140));}
    else console.log(`SAME  ${n}`);
  }
  console.log('\ndiffs:',d);
})();
