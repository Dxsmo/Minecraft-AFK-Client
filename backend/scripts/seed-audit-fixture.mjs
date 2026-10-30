// Refuses populated databases and any database URL other than the audit fixture.
import assert from 'node:assert/strict';
import { prisma } from '../dist/database/prisma.js';
import { hashPassword } from '../dist/auth/password.js';
assert.equal(process.env.DATABASE_URL,'file:/app/data/audit.db');
assert.equal(await prisma.minecraftAccount.count(),0,'Refuse to alter an existing data set');
const admin=await prisma.user.findUniqueOrThrow({where:{username:'AuditAdmin'}});
const member=await prisma.user.create({data:{username:'AuditMember',role:'USER',passwordHash:await hashPassword('Audit-member-only-2026!')}});
await prisma.minecraftAccount.createMany({data:Array.from({length:100},(_,i)=>({id:`audit-${String(i).padStart(3,'0')}`,name:`AuditFixture${i}`,edition:i%2?'BEDROCK':'JAVA',serverHost:'unused.invalid',authType:'OFFLINE',autoStart:false,autoSellEnabled:false,createdById:i<50?admin.id:member.id}))});
await prisma.userMinecraftAccount.createMany({data:[0,1].map(i=>({userId:member.id,minecraftAccountId:`audit-${String(i).padStart(3,'0')}`}))});
await prisma.consoleLog.createMany({data:Array.from({length:20000},(_,i)=>({minecraftAccountId:'audit-000',type:'CHAT',message:`Audit history ${i}`,createdAt:new Date(Date.now()-20000+i)}))});
for(let offset=0;offset<100000;offset+=5000)await prisma.sellEarning.createMany({data:Array.from({length:5000},(_,j)=>({minecraftAccountId:`audit-${String((offset+j)%100).padStart(3,'0')}`,amount:1.21,createdAt:new Date(Date.now()-((offset+j)%86400)*1000)}))});
const content=JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Audit shared note'}]}]});
await prisma.note.create({data:{id:'audit-shared-note',title:'Audit shared note',content,ownerId:admin.id,grants:{create:{userId:member.id,canWrite:false}}}});
await prisma.note.create({data:{id:'audit-private-note',title:'Member private note',content,ownerId:member.id}});
console.log(JSON.stringify({accounts:100,logs:20000,earnings:100000,users:2,notes:2}));
await prisma.$disconnect();
