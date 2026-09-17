const { parseSwift } = require('../src/index.js');
const { customized } = require('./fixtures.js');
function astTransform(contents) {
  const file = parseSwift(contents);
  file.addImport('Expo', { access: 'internal' });
  const ad = file.type('AppDelegate');
  ad.setSupertype('ExpoAppDelegate', { replacing: ['UIResponder', 'UIApplicationDelegate'] });
  const fn = ad.functions().find(f => f.selector?.startsWith('application(_:didFinishLaunchingWithOptions:'));
  const p = fn.node.namedChildren.filter(c=>c.type==='parameter').find(c=>c.childForFieldName('external_name')?.text==='didFinishLaunchingWithOptions');
  const opts = p?.childForFieldName('name')?.text ?? 'launchOptions';
  fn.addModifier('override');
  fn.replaceReturnValue(`super.application(application, didFinishLaunchingWithOptions: ${opts})`);
  const d = file.type('ReactNativeDelegate');
  d.setSupertype('ExpoReactNativeFactoryDelegate');
  d.func('sourceURL(for:)')?.replaceReturnValue('bridge.bundleURL ?? bundleURL()');
  return file.toString();
}
const out = astTransform(customized);
const a = customized.split('\n'), b = out.split('\n');
// simple line diff
let i=0,j=0;
while(i<a.length||j<b.length){
  if(a[i]===b[j]){i++;j++;continue;}
  if(b[j]!==undefined && !a.includes(b[j])){console.log('+ '+b[j]);j++;continue;}
  if(a[i]!==undefined && !b.includes(a[i])){console.log('- '+a[i]);i++;continue;}
  i++;j++;
}
console.log('\n--- reparse check ---');
const re = parseSwift(out);
console.log('output parses with errors:', re.hasParseErrors);
