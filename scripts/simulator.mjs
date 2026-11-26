import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A real Cicord process on simulated Discord, using the plugin under test from this checkout. */
export async function startSimulator(t, pluginDir, grants, config, options = {}) {
  const health=Array.isArray(options.health)?options.health:[options.health??"Healthy"];
  const root = await mkdtemp(join(tmpdir(),"cicord-plugin-test-"));
  const repo=join(root,"acceptance"), name=basename(pluginDir);
  t.after(()=>rm(root,{recursive:true,force:true}));
  execFileSync("cicord",["init",repo],{stdio:"pipe"});
  await cp(pluginDir,join(repo,"plugins",name),{recursive:true,filter:path=>![".cicord","node_modules","dist",".git"].includes(basename(path))});
  for (const [name, content] of Object.entries(options.files ?? {})) {
    const dest=join(repo,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,content);
  }
  const fields=Object.entries(options.instance ?? {}).map(([k,v])=>"\n      "+k+": "+JSON.stringify(v)).join("");
  const botFile=join(repo,"bots","bot","bot.yaml");
  const yaml=await readFile(botFile,"utf8");
  assert.ok(yaml.includes("plugins: []"));
  await writeFile(botFile,yaml.replace("plugins: []",`plugins:\n    - name: ${name}\n      source: ../../plugins/${name}\n      grants: ${JSON.stringify(grants)}${fields}\n      config: ${JSON.stringify(config)}`));
  const dataDir=join(root,"state");
  await options.prepare?.({root,repo,dataDir,pluginDir:join(repo,"plugins",name)});
  const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");
  const port=probe.address().port;
  const address=`127.0.0.1:${port}`;
  await new Promise(resolve=>probe.close(resolve));
  const child=spawn("cicord",["dev","--sim","--listen",address,"--data-dir",dataDir,repo],{
    env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,CICORD_RUNTIME_TOKEN:"local-simulator-only"},
    stdio:["ignore","ignore","pipe"],
  });
  let stderr="";
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
  const exited=once(child,"exit");
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){child.kill("SIGTERM");await exited;}});
  const base=`http://${address}`;
  async function api(path,body,token,method=body===undefined?"GET":"POST") {
    const response=await fetch(base+path,{method,
      headers:{"Content-Type":"application/json","X-Cicord-Request":"1",...(token?{Authorization:`Bearer ${token}`}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();
    if(!response.ok)throw new Error(`${path} returned ${response.status}: ${text}`);
    return text?JSON.parse(text):undefined;
  }
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
    if(child.exitCode!==null || child.signalCode!==null)throw new Error(`simulator exited: ${stderr}`);
    try{
      const status=await api("/api/v1/status",undefined,"local-simulator-only");
      ready=status.bots?.some(bot=>bot.plugins?.some(p=>p.instance===name && health.includes(p.health)));
    }catch(error){if(!(error instanceof TypeError))throw error;}
    if(ready)break;
    await delay(100);
  }
  assert.ok(ready,`plugin did not start: ${stderr}`);
  const state=await api("/api/v1/sim/state");
  const guild=state.servers[0], owner=state.users.find(u=>u.username==="owner");
  const channel=guild.channels.find(c=>c.name==="general");
  assert.ok(owner && channel);
  return {api,repo,root,dataDir,port,guild,users:state.users,owner,channel,
    join:user=>api(`/api/v1/sim/servers/${guild.id}/members`,{userId:user.id}),
    command:(as,command,options={})=>api("/api/v1/sim/commands",{serverId:guild.id,channelId:channel.id,userId:as.id,bot:"bot",name:command,options}),
    login:async user=>(await api("/auth/dev-login",{mode:"token",userId:user.id})).token,
  };
}
