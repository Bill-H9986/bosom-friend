const fs = require('fs');

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function walkTree(node, prefix, files) {
  if (node.type === 'file') {
    files.push(prefix + '/' + node.name);
  } else if (node.files) {
    node.files.forEach((child) => walkTree(child, prefix + '/' + node.name, files));
  }
}

for (const file of process.argv.slice(2)) {
  const raw = stripBom(fs.readFileSync(file, 'utf8'));
  const j = JSON.parse(raw);
  const files = [];
  j.files.forEach((n) => walkTree(n, '', files));
  console.log('=== ' + file + ' (' + files.length + ')');
  console.log(files.join('\n'));
}
