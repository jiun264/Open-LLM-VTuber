const fs = require('fs');
const path = require('path');

const charDir = path.join(__dirname, 'characters', '薇薇安__3_', '薇薇安');
const cdiFile = path.join(charDir, '薇薇安.cdi3.json');
const modelFile = path.join(charDir, '薇薇安.model3.json');

const cdi = JSON.parse(fs.readFileSync(cdiFile, 'utf8'));
const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));

const cdiParamMap = new Map();
(cdi.Parameters || []).forEach(p => {
  cdiParamMap.set(p.Id, p.Name);
});

console.log(`=== Total Parameters in CDI: ${cdiParamMap.size} ===`);

// Check expressions in model3.json
const expressions = model.FileReferences?.Expressions || [];
console.log(`\n=== Expressions registered in model3.json (${expressions.length}) ===`);
expressions.forEach((expr, idx) => {
  console.log(`[Index ${idx}] Name: ${expr.Name}, File: ${expr.File}`);
  const expPath = path.join(charDir, expr.File);
  if (fs.existsSync(expPath)) {
    const expData = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    (expData.Parameters || []).forEach(p => {
      const exists = cdiParamMap.has(p.Id);
      const name = cdiParamMap.get(p.Id) || 'NOT_IN_CDI';
      console.log(`    Id: ${p.Id.padEnd(12)} Blend: ${p.Blend.padEnd(10)} Value: ${String(p.Value).padEnd(6)} (In CDI: ${exists}, Name: ${name})`);
    });
  } else {
    console.log(`    File NOT FOUND: ${expPath}`);
  }
});

// Check Motions in model3.json
const motions = model.FileReferences?.Motions || {};
console.log(`\n=== Motions in model3.json ===`);
for (const [group, mList] of Object.entries(motions)) {
  console.log(`Group: ${group}`);
  mList.forEach((m, idx) => {
    const mPath = path.join(charDir, m.File);
    console.log(`  [${idx}] File: ${m.File}`);
    if (fs.existsSync(mPath)) {
      const mData = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const paramCurves = (mData.Curves || []).filter(c => c.Target === 'Parameter');
      console.log(`      Parameter curves: ${paramCurves.length}`);
      const curveIds = paramCurves.map(c => c.Id);
      console.log(`      IDs: ${curveIds.join(', ')}`);
    }
  });
}
