import { resolve } from 'node:path';

// OpenCode 1.18.35 may strip the leading slash from an edit pattern.
// That spelling needs a separately supplied, declared absolute metadata path.
export function allowsDeclaredEdit(detail, workspace, allowedPaths) {
  const patterns=detail.patterns;
  if(detail.permission!=='edit'||!Array.isArray(patterns)||patterns.length===0)return false;
  return patterns.every(p=>typeof p==='string' && (
    allowedPaths.includes(resolve(workspace,p)) ||
    (typeof detail.metadata?.filepath==='string' && allowedPaths.includes(detail.metadata.filepath) &&
      p===detail.metadata.filepath.slice(1))));
}
