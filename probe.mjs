import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import { chromium } from "playwright-core";

const targets=JSON.parse(process.env.TARGETS_JSON??"[]");
if(!Array.isArray(targets)||targets.length<2||targets.length>5)throw new Error("Supply 2 to 5 targets.");
for(const target of targets){
  const url=new URL(target.url);
  if(url.protocol!=="https:"||url.username||url.password||url.port||!url.hostname.includes(".")||/^(?:\d|localhost)/i.test(url.hostname))throw new Error("Only public HTTPS targets are supported.");
  if(!/^\d{1,15}$/.test(String(target.id))||typeof target.expired!=="boolean")throw new Error("Expected record ID and expiration flag are required.");
}

function detailFromHtml(html){
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
    const json=match[1].match(/\bwindow\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/)?.[1];
    if(!json)continue;
    try{const thread=JSON.parse(json).threadDetail;if(thread)return thread;}catch{/* Non-JSON scripts are not authoritative data. */}
  }
  return null;
}
function checkedDetail(thread,target){
  if(!thread)return {readable:false,reason:"missing_thread_detail"};
  const heat=thread.temperature;
  const expired=thread.isExpired;
  const id=String(thread.threadId);
  const valid=id===String(target.id)&&typeof heat==="number"&&Number.isFinite(heat)&&typeof expired==="boolean";
  const endTimestamp=thread.endDate?.timestamp;
  return {readable:valid,expectedStateMatches:valid&&expired===target.expired,
    threadId:id,title:typeof thread.title==="string"?thread.title.slice(0,180):null,
    temperature:typeof heat==="number"&&Number.isFinite(heat)?heat:null,
    isExpired:typeof expired==="boolean"?expired:null,
    expiresAt:typeof endTimestamp==="number"&&endTimestamp>0&&endTimestamp<4_102_444_800?new Date(endTimestamp*1000).toISOString():null};
}
function publicPageUrl(value){const url=new URL(value);return url.origin+url.pathname;}
async function direct(target){
  const started=Date.now();
  try{
    const response=await fetch(target.url,{redirect:"follow",signal:AbortSignal.timeout(25_000),headers:{"User-Agent":"PublicPageAccessProbe/1.0",Accept:"text/html,application/xhtml+xml"}});
    const html=await response.text();
    return {method:"http",url:target.url,status:response.status,finalUrl:publicPageUrl(response.url),mitigated:response.headers.get("cf-mitigated"),characters:html.length,
      sha256:createHash("sha256").update(html).digest("hex"),elapsedMs:Date.now()-started,
      ...(response.ok?checkedDetail(detailFromHtml(html),target):{readable:false,reason:"http_error"})};
  }catch(error){return {method:"http",url:target.url,readable:false,reason:"request_error",error:error.message,elapsedMs:Date.now()-started};}
}
async function rendered(browser,target){
  const started=Date.now();
  const context=await browser.newContext();
  const page=await context.newPage();
  let lastNavigationResponse=null;
  page.on("response",response=>{
    if(response.request().isNavigationRequest()&&response.frame()===page.mainFrame())lastNavigationResponse=response;
  });
  try{
    await page.goto(target.url,{waitUntil:"domcontentloaded",timeout:30_000});
    // Let ordinary page scripts and redirects settle. Do not interact with challenges.
    await page.waitForFunction(()=>Boolean(window.__INITIAL_STATE__?.threadDetail),null,{timeout:20_000}).catch(()=>{});
    const response=lastNavigationResponse;
    const status=response?.status()??0;
    const html=await page.content();
    const thread=detailFromHtml(html);
    return {method:"browser",url:target.url,finalUrl:publicPageUrl(page.url()),status,
      mitigated:response?.headers()["cf-mitigated"]??null,pageTitle:await page.title(),characters:html.length,
      sha256:createHash("sha256").update(html).digest("hex"),elapsedMs:Date.now()-started,
      ...(status>=200&&status<300?checkedDetail(thread,target):{readable:false,reason:"http_error"})};
  }catch(error){return {method:"browser",url:target.url,readable:false,reason:"browser_error",error:error.message,elapsedMs:Date.now()-started};}
  finally{await context.close();}
}
const report={checkedAt:new Date().toISOString(),runtime:"GitHub-hosted "+os.platform()+" VM",outsideCloudflareWorkers:true,
  server:{platform:os.platform(),release:os.release(),architecture:os.arch(),runnerEnvironment:process.env.RUNNER_ENVIRONMENT??null,
    image:process.env.ImageOS??null,imageVersion:process.env.ImageVersion??null,runId:process.env.GITHUB_RUN_ID??null},
  browserVersion:null,browserMode:process.env.HEADED==="1"?"headed":"headless",rounds:[],passed:false};
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN??"/usr/bin/google-chrome",headless:process.env.HEADED!=="1"});
  report.browserVersion=browser.version();
  for(let index=0;index<2;index++){
    if(index)await delay(45_000);
    const round={number:index+1,checkedAt:new Date().toISOString(),results:[]};
    for(const target of targets){
      round.results.push(await direct(target));
      round.results.push(await rendered(browser,target));
      await delay(2_000);
    }
    report.rounds.push(round);
    for(const result of round.results)console.log("READ_RESULT "+JSON.stringify({round:round.number,...result}));
  }
  report.passed=report.rounds.length===2&&report.rounds.every(round=>targets.every(target=>round.results.some(result=>result.url===target.url&&result.readable&&result.expectedStateMatches)));
}catch(error){report.error=error.message;}
finally{if(browser)await browser.close();}
await fs.writeFile("report.json",JSON.stringify(report,null,2)+"\n");
console.log("FINAL_REPORT "+JSON.stringify(report));
if(process.env.GITHUB_STEP_SUMMARY){
  const rows=report.rounds.flatMap(round=>round.results.map(row=>`| ${round.number} | ${row.method} | ${row.status??"error"} | ${row.threadId??"unreadable"} | ${row.temperature??"unknown"} | ${row.isExpired??"unknown"} | ${row.readable&&row.expectedStateMatches?"PASS":"FAIL"} |`));
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`# Public data verification: ${report.passed?"PASS":"FAIL"}\n\nRuntime: ${report.runtime}. Browser: ${report.browserVersion??"unavailable"}.\n\n| Round | Method | HTTP | Record ID | Temperature | Expired | Result |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\nNo publishing, service credentials, purchased resources, artifacts or scheduled jobs.\n`);
}
process.exitCode=report.passed?0:1;
