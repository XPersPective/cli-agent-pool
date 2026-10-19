import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { allowedWorkspace, PoolError } from './config.js';

export function workspaceSkills(workspace, workspaceRoots, libraryRoot = path.join(homedir(), '.skills-manager', 'skills')) {
  if (typeof workspace !== 'string' || workspace.length > 4096) throw new PoolError('INVALID_WORKSPACE', 'Geçerli bir proje seçin.');
  const project = workspace ? allowedWorkspace(workspace, workspaceRoots) : null;
  const roots = [...(project ? ['.agents/skills','.codex/skills','.claude/skills','skills'].map(dir => ({root:path.join(project,dir),source:'Proje'})) : []), {root:libraryRoot,source:'Kütüphane'}];
  const skills=[], seen=new Set();
  for (const {root,source} of roots) {
    let actual,entries;
    try {
      actual=realpathSync(root);
      const relative = project ? path.relative(project,actual) : '';
      if (source==='Proje' && (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))) continue;
      entries=readdirSync(actual,{withFileTypes:true});
    } catch { continue; }
    // ponytail: immediate standard skill directories, capped at 500; add paged traversal if libraries exceed this ceiling.
    for (const entry of entries) {
      if (!entry.isDirectory() || skills.length>=500) continue;
      const file=path.join(actual,entry.name,'SKILL.md');
      try {
        const stat=lstatSync(file); if(!stat.isFile() || stat.size>65536 || seen.has(file)) continue;
        const text=readFileSync(file,'utf8'), front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/ )?.[1] || '';
        const field=front.match(/^description:[ \t]*(.*)(?:\r?\n((?:[ \t]+.*(?:\r?\n|$))*))?/m);
        const description=(/^[>|][-+]?$/.test(field?.[1] || '') ? field?.[2] || '' : field?.[1] || '').replace(/^['"]|['"]$/g,'').replace(/\s+/g,' ').trim().slice(0,500);
        skills.push({id:file,name:entry.name,description,source});seen.add(file);
      } catch { /* Missing or oversized skill files are not available to attach. */ }
    }
  }
  return skills.sort((a,b)=>a.source.localeCompare(b.source,'tr') || a.name.localeCompare(b.name,'tr'));
}

export function readWorkspaceSkill(workspace, workspaceRoots, id, libraryRoot) {
  if(typeof id!=='string' || id.length>8192) throw new PoolError('INVALID_SKILL','Geçerli bir skill seçin.');
  const skill=workspaceSkills(workspace,workspaceRoots,libraryRoot).find(skill=>skill.id===id);
  if(!skill) throw new PoolError('INVALID_SKILL','Skill bu proje veya kütüphanede bulunamadı.');
  const stat=lstatSync(skill.id);
  if(!stat.isFile() || stat.size>65536) throw new PoolError('INVALID_SKILL','Skill dosyası okunamıyor veya 64 KB sınırını aşıyor.');
  return {...skill,text:readFileSync(skill.id,'utf8')};
}
