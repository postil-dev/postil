import { appendFileSync } from "node:fs";

// This program is sent over the existing named Fly machine-exec transport.
// The immutable target image does not need to contain this deployment helper.
export const remoteReviewProgram = String.raw`(async () => {
  const {createSign}=require('node:crypto');
  const {Client}=require('pg');
  const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
  const exactId=value=>Number.isSafeInteger(value)&&value>0;
  const exactSha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)||
     !exactId(input.pr)||!exactId(input.checkRun)||!exactSha(input.head)||
     !exactSha(input.target)||!/^postil [0-9]+\.[0-9]+\.[0-9]+$/.test(input.version)||
     !/^[0-9a-f]{64}$/.test(input.hash)||!exactId(input.deadline))throw Error('invalid input');
  const end=Math.min(Date.now()+9*60*1000,input.deadline*1000-35*60*1000);
  if(end-Date.now()<8*60*1000)throw Error('insufficient recovery budget');
  const db=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000,query_timeout:5000,statement_timeout:5000});
  await db.connect();
  const read=async(query,args)=>{await db.query('BEGIN READ ONLY');try{const result=await db.query(query,args);await db.query('COMMIT');return result.rows;}catch(error){await db.query('ROLLBACK');throw error;}};
  const owner=await read(
    'SELECT i.github_installation_id AS installation, i.suspended, r.github_repo_id AS repo_id, r.enabled, r.full_name FROM repositories r JOIN installations i ON i.id=r.installation_id WHERE r.full_name=$1',
    [input.repository]);
  if(owner.length!==1||owner[0].suspended||!owner[0].enabled||!exactId(Number(owner[0].installation))||!exactId(Number(owner[0].repo_id)))throw Error('repository ownership');
  const installation=Number(owner[0].installation), repoId=Number(owner[0].repo_id);
  const previous=await read(
    'SELECT v.id FROM reviews v JOIN repositories r ON r.id=v.repository_id WHERE r.github_repo_id=$1 AND v.pr_number=$2 AND v.head_sha=$3 AND v.source_github_installation_id=$4 AND v.source_github_repo_id=$1 AND (v.advisory_check_run_id=$5 OR v.gate_check_run_id=$5) ORDER BY v.id DESC LIMIT 2',
    [repoId,input.pr,input.head,installation,input.checkRun]);
  if(previous.length!==1)throw Error('check run ownership');
  const appId=Number(process.env.GITHUB_APP_ID);
  if(!exactId(appId))throw Error('App identity');
  // Only after exact local ownership is established may the App key be read.
  let key=process.env.GITHUB_APP_PRIVATE_KEY;
  if(!key)throw Error('App credential');
  key=key.includes('-----BEGIN')?key.replace(/\\n/g,'\n'):Buffer.from(key,'base64').toString();
  if(!key.includes('-----BEGIN'))throw Error('App credential');
  const api=process.env.GITHUB_API_URL||'https://api.github.com';
  const request=async(path,token,method='GET')=>{
    const remaining=Math.min(10000,end-Date.now()-1000);
    if(remaining<1000)throw Error('acceptance deadline');
    const response=await fetch(api+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'postil-release-probe'},signal:AbortSignal.timeout(remaining)});
    if(!response.ok)throw Error('GitHub request failed');
    const body=await response.text();
    if(body.length>65536)throw Error('GitHub response too large');
    return JSON.parse(body);
  };
  const rerequest=async(token)=>{
    const remaining=Math.min(10000,end-Date.now()-1000);
    if(remaining<1000)throw Error('acceptance deadline');
    const response=await fetch(api+'/repos/'+input.repository+'/check-runs/'+input.checkRun+'/rerequest',
      {method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'postil-release-probe'},signal:AbortSignal.timeout(remaining)});
    if(response.status!==201)throw Error('rerequest not accepted');
  };
  const now=Math.floor(Date.now()/1000);
  const jwtPart=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned=jwtPart({alg:'RS256',typ:'JWT'})+'.'+jwtPart({iat:now-60,exp:now+540,iss:String(appId)});
  const signer=createSign('RSA-SHA256'); signer.update(unsigned);
  const jwt=unsigned+'.'+signer.sign(key).toString('base64url'); key='';
  const app=await request('/app',jwt);
  if(app.id!==appId)throw Error('App owner mismatch');
  const issued=await request('/app/installations/'+installation+'/access_tokens',jwt,'POST');
  const token=issued.token;
  if(typeof token!=='string'||token.length<20)throw Error('installation token unavailable');
  const repository=await request('/repos/'+input.repository,token);
  if(repository.id!==repoId||repository.full_name!==input.repository)throw Error('repository changed');
  const pr=await request('/repos/'+input.repository+'/pulls/'+input.pr,token);
  if(pr.number!==input.pr||pr.state!=='open'||pr.head?.sha!==input.head||pr.base?.repo?.id!==repoId)throw Error('PR changed');
  const selected=await request('/repos/'+input.repository+'/check-runs/'+input.checkRun,token);
  if(selected.id!==input.checkRun||selected.head_sha!==input.head||selected.app?.id!==appId||
     !['postil/review','postil/gate'].includes(selected.name)||
     !Array.isArray(selected.pull_requests)||selected.pull_requests.length!==1||
     selected.pull_requests[0]?.number!==input.pr||selected.pull_requests[0]?.head?.sha!==input.head)throw Error('check run association changed');
  const observations=async(watermark)=>read(
    'SELECT v.id, v.public_id, v.status, v.error_message IS NULL AS no_error, v.finished_at IS NOT NULL AS finished, v.advisory_check_run_id AS advisory, v.gate_check_run_id AS gate, EXISTS (SELECT 1 FROM review_logs l WHERE l.review_id=v.id AND l.line=$6) AS cli_match FROM reviews v JOIN repositories r ON r.id=v.repository_id WHERE r.github_repo_id=$1 AND v.pr_number=$2 AND v.head_sha=$3 AND v.source_github_installation_id=$4 AND v.source_github_repo_id=$1 AND v.source_repo_full_name=$5 AND v.trigger_source=\'github_check_rerun\' AND v.trigger_context->>\'webhookEvent\'=\'check_run\' AND v.trigger_context->>\'webhookAction\'=\'rerequested\' AND v.trigger_context->>\'checkName\'=$7 AND v.id>$8 ORDER BY v.id LIMIT 10',
    [repoId,input.pr,input.head,installation,input.repository,'postil CLI version '+input.version,selected.name,watermark]);
  const terminalCheck=async(id,name,publicId)=>{
    if(!exactId(Number(id)))return false;
    const check=await request('/repos/'+input.repository+'/check-runs/'+id,token);
    return check.id===Number(id)&&check.name===name&&check.head_sha===input.head&&
      check.app?.id===appId&&check.external_id==='postil:'+publicId+':'+(name==='postil/gate'?'gate':'review')&&
      check.status==='completed'&&
      (name==='postil/review'?check.conclusion==='success':['success','failure','neutral'].includes(check.conclusion));
  };
  let watermark=Number((await read('SELECT COALESCE(MAX(v.id),0) AS id FROM reviews v JOIN repositories r ON r.id=v.repository_id WHERE r.github_repo_id=$1 AND v.pr_number=$2 AND v.head_sha=$3',[repoId,input.pr,input.head]))[0].id);
  for(let attempt=1;attempt<=3;attempt++){
    await rerequest(token);
    const attemptEnd=Math.min(end,Date.now()+3*60*1000);
    let completedAttempt=false;
    while(Date.now()<attemptEnd){
      const rows=await observations(watermark);
      if(rows.length>0){
        if(rows.length===10)throw Error('ambiguous webhook attempts');
        const allTerminal=rows.every(row=>['completed','failed','stale'].includes(row.status)&&row.finished);
        if(allTerminal){
          let targetObserved=false;
          for(const row of rows){
            if(row.status!=='completed'||!row.no_error||!row.cli_match)continue;
            targetObserved=true;
            if(await terminalCheck(row.advisory,'postil/review',row.public_id)&&
               await terminalCheck(row.gate,'postil/gate',row.public_id)){
              await db.end();
              process.stdout.write(JSON.stringify({target:input.target,version:input.version,hash:input.hash,
                repository:input.repository,pr:input.pr,head:input.head,reviewId:Number(row.id),
                advisoryCheckRunId:Number(row.advisory),gateCheckRunId:Number(row.gate)}));
              return;
            }
          }
          if(!targetObserved){
            watermark=Math.max(...rows.map(row=>Number(row.id)));
            completedAttempt=true;
            break;
          }
        }
      }
      await Bun.sleep(10000);
    }
    // A missing or incomplete matching review cannot authorize another request.
    if(!completedAttempt)break;
  }
  await db.end();
  throw Error('bounded hosted acceptance inconclusive');
})().catch(()=>{console.error('owned hosted acceptance inconclusive');process.exit(1)});`;

function main() {
  const required = ["ACCEPTANCE_CONTEXT", "FIRST_WORKER_ID", "TARGET_RELEASE_SHA", "POSTIL_CLI_VERSION",
    "POSTIL_CLI_HASH", "ROLLBACK_DEADLINE_EPOCH"];
  for (const name of required) if (!process.env[name]) throw new Error(`missing ${name}`);
  const owned = JSON.parse(process.env.ACCEPTANCE_CONTEXT!) as Record<string, unknown>;
  const input = {
    repository: owned.repository,
    pr: owned.pr,
    head: owned.head,
    checkRun: owned.checkRun,
    target: process.env.TARGET_RELEASE_SHA,
    version: process.env.POSTIL_CLI_VERSION,
    hash: process.env.POSTIL_CLI_HASH,
    deadline: Number(process.env.ROLLBACK_DEADLINE_EPOCH),
  };
  const machine = process.env.FIRST_WORKER_ID!;
  if (!/^[0-9a-f]+$/.test(machine)) throw new Error("invalid first worker ID");
  const command = `bun -e 'eval(Buffer.from("${Buffer.from(remoteReviewProgram).toString("base64")}","base64").toString())' ${Buffer.from(JSON.stringify(input)).toString("base64")}`;
  const result = Bun.spawnSync(["flyctl", "machine", "exec", machine, command, "--app", "postil-web", "--timeout", "600"],
    { stdout: "pipe", stderr: "pipe", timeout: 610_000 });
  if (result.exitCode !== 0 || result.stdout.length > 4096) throw new Error("owned hosted acceptance inconclusive");
  const receipt = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  if (receipt.target !== input.target || receipt.version !== input.version || receipt.hash !== input.hash ||
      receipt.repository !== input.repository || receipt.pr !== input.pr || receipt.head !== input.head ||
      !Number.isSafeInteger(receipt.reviewId) || !Number.isSafeInteger(receipt.advisoryCheckRunId) ||
      !Number.isSafeInteger(receipt.gateCheckRunId)) throw new Error("owned hosted acceptance receipt mismatch");
  console.log(JSON.stringify(receipt));
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `accepted=true\nreview-id=${receipt.reviewId}\n`);
}

if (import.meta.main) {
  try { main(); }
  catch { console.error("Owned hosted acceptance inconclusive; source peers remain unchanged."); process.exit(1); }
}
