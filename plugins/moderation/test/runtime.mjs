import "./quarantine-runtime.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startSimulator } from "../../../scripts/simulator.mjs";

test("a temporary guild ban expires through the actual task scheduler", {timeout:100_000},async t=>{
 const dir=fileURLToPath(new URL("..",import.meta.url)).replace(/\/$/,"");
 const grants=["discord.messages.send","discord.messages.manage","discord.messages.read","discord.channels.read",
  "discord.members.read","discord.auditlog.read","discord.members.moderate","discord.dm.send","storage.kv","http.fetch","portal.routes","events.publish","scheduler"];
 const sim=await startSimulator(t,dir,grants,{logChannel:"general"});
 const alice=sim.users.find(u=>u.username==="alice");
 await sim.join(alice);
 const result=await sim.command(sim.owner,"ban",{member:alice.id,duration:1,reason:"case expiry test"});
 assert.equal(result.status,"replied",JSON.stringify(result));
 await assert.rejects(()=>sim.join(alice),/403/);
 const ownerToken=await sim.login(sim.owner);
 const cases=()=>sim.api("/api/v1/portal/acceptance/plugins/bot/moderation/cases",undefined,ownerToken);
 assert.ok((await cases()).items.some(c=>c.action==="tempban" && c.status==="active"));
 for(let n=0;n<75;n++){
   const {items}=await cases();
   if(items.some(c=>c.action==="unban")){
     assert.equal(items.filter(c=>c.action==="unban").length,1);
     assert.equal(items.find(c=>c.action==="tempban").status,"expired");
     await sim.join(alice);return;
   }
   await delay(1000);
 }
 assert.fail("temporary ban did not expire");
});
