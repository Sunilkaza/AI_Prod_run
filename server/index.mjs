import 'dotenv/config';
import express from 'express';
import {Storage} from '@google-cloud/storage';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';

const app = express();
const bucket = process.env.GCS_BUCKET;
const objects = {
  'splunk-logs.json': process.env.GCS_SPLUNK_OBJECT || 'app_logs/splunk-logs.json',
  'change-requests.json': process.env.GCS_CHANGE_OBJECT || 'snow_data/change-requests.json'
};
// Uses Application Default Credentials (ADC). No long-lived service account key.
// Optional GOOGLE_IMPERSONATE_SERVICE_ACCOUNT is supported through gcloud's
// `gcloud auth application-default login --impersonate-service-account=...`.
const storage = new Storage({projectId:process.env.GOOGLE_CLOUD_PROJECT || undefined});

app.get('/api/ingestion/:filename', async (req,res)=>{
  const objectName = objects[req.params.filename];
  if (!objectName) return res.status(404).json({error:'Unsupported ingestion file'});
  if (!bucket) return res.status(503).json({error:'GCS_BUCKET not configured'});
  try {
    const file=storage.bucket(bucket).file(objectName);
    const [metadata]=await file.getMetadata();
    if (Number(metadata.size)>5_000_000) return res.status(413).json({error:'Object exceeds demo size limit'});
    const [bytes]=await file.download();
    if(bytes.length>5_000_000) return res.status(413).json({error:'Object exceeds demo size limit'});
    const data=JSON.parse(bytes.toString('utf8'));
    if(!Array.isArray(data)) return res.status(422).json({error:'Expected JSON array'});
    res.set('Cache-Control','no-store');
    res.set('X-AgentOps-Source',`gs://${bucket}/${objectName}`);
    res.set('X-AgentOps-Generation',String(metadata.generation||''));
    res.json(data);
  } catch(err) {
    console.error(`GCS read failed for ${objectName}:`,err.message);
    res.status(502).json({error:'Private GCS read failed. Verify ADC identity, bucket IAM, and object path.'});
  }
});
app.get('/api/ingestion/source-info',(req,res)=>res.json({mode:'private-gcs-adc',bucket,objects,authentication:'Application Default Credentials',connected:false}));
// Demo ticket registry persists across backend restarts. Do not store credentials here.
app.use(express.json({limit:'16kb'}));
const registryPath=join(process.cwd(),'server','servicenow-tickets.json');
let ticketRegistry={};
try { ticketRegistry=JSON.parse(await readFile(registryPath,'utf8')); } catch (e) { if(e.code!=='ENOENT') console.warn('Ticket registry could not be loaded:',e.message); }
let ticketQueue=Promise.resolve();
const safeString=(v,n=300)=>String(v??'').slice(0,n);
app.get('/api/servicenow/status',(req,res)=>res.json({configured:Boolean(process.env.SERVICENOW_INSTANCE_URL&&process.env.SERVICENOW_USERNAME&&process.env.SERVICENOW_PASSWORD),enabled:process.env.SERVICENOW_ENABLED==='true',tickets:ticketRegistry}));
app.post('/api/servicenow/failure',(req,res)=>{
  const task=async()=>{
    if(process.env.SERVICENOW_ENABLED!=='true') return res.status(503).json({error:'ServiceNow ticket creation disabled. Set SERVICENOW_ENABLED=true in .env.'});
    const {incident_id,failed_stage,failure_reason}=req.body||{};
    if(!/^INC[0-9]{7,12}$/.test(incident_id||'')) return res.status(400).json({error:'Valid AgentOps incident_id required'});
    if(!['ingest','orch','play','approval','dbrun'].includes(failed_stage)) return res.status(400).json({error:'Invalid failed stage'});
    if(typeof failure_reason!=='string'||!failure_reason.trim()) return res.status(400).json({error:'Failure reason required'});
    // Source of truth is the GCS object, not caller-supplied environment/host/service.
    let logs,changes;
    try {
      const [logBytes,changeBytes]=await Promise.all([storage.bucket(bucket).file(objects['splunk-logs.json']).download(),storage.bucket(bucket).file(objects['change-requests.json']).download()]);
      logs=JSON.parse(logBytes[0].toString('utf8'));
      changes=JSON.parse(changeBytes[0].toString('utf8'));
    } catch(e) { console.error('ServiceNow GCS verification failed:',e.message); return res.status(502).json({error:'Cannot verify incident against private GCS data'}); }
    const records=logs.filter(x=>x.incident_id===incident_id);
    if(!records.length) return res.status(404).json({error:'Incident not found in GCS Splunk logs'});
    const latest=records[records.length-1],change=changes.find(x=>x.incident_id===incident_id);
    if(ticketRegistry[incident_id]) return res.json({...ticketRegistry[incident_id],reused:true});
    const instance=(process.env.SERVICENOW_INSTANCE_URL||'').replace(/\/$/,'');
    if(!/^https:\/\/[a-z0-9-]+\.service-now\.com$/i.test(instance)) return res.status(503).json({error:'Configure a valid ServiceNow instance URL'});
    const username=process.env.SERVICENOW_USERNAME,password=process.env.SERVICENOW_PASSWORD;
    if(!username||!password) return res.status(503).json({error:'ServiceNow credentials not configured'});
    const body={short_description:`[AGENTOPS DEMO] ${safeString(latest.service,40)} remediation failed - ${incident_id}`,description:[`SIMULATED REMEDIATION FAILURE - DEVELOPMENT DEMO`,`AgentOps correlation ID: ${incident_id}`,`Environment: ${safeString(latest.environment,30)}`,`Host: ${safeString(latest.host,100)}`,`Service: ${safeString(latest.service,50)}`,`Event: ${safeString(latest.event_code,80)}`,`Splunk message: ${safeString(latest.message,600)}`,`Related change: ${safeString(change?.change_id||latest.change_id,40)}`,`Failed stage: ${failed_stage}`,`Failure reason: ${safeString(failure_reason,500)}`,`Generated: ${new Date().toISOString()}`].join('\n'),category:'software',impact:latest.environment==='PROD'?'2':'3',urgency:latest.environment==='PROD'?'2':'3',work_notes:'Created by AgentOps Command Center demo after simulated stage failure. No live infrastructure remediation was executed.'};
    try {
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);
      let response;
      try {response=await fetch(`${instance}/api/now/table/incident`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${username}:${password}`).toString('base64'),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}finally{clearTimeout(timeout)}
      const payload=await response.json().catch(()=>({}));
      if(!response.ok){console.error('ServiceNow create failed:',response.status,JSON.stringify(payload).slice(0,500));return res.status(502).json({error:`ServiceNow returned HTTP ${response.status}. Check backend logs and API permissions.`});}
      if(!payload.result?.sys_id||!payload.result?.number) return res.status(502).json({error:'ServiceNow response did not include incident number and sys_id'});
      const result={incident_id,number:payload.result.number,sys_id:payload.result.sys_id,url:`${instance}/nav_to.do?uri=incident.do%3Fsys_id%3D${encodeURIComponent(payload.result.sys_id)}`,created_at:new Date().toISOString()};
      ticketRegistry[incident_id]=result;
      try {const tmp=registryPath+'.tmp';await writeFile(tmp,JSON.stringify(ticketRegistry,null,2));await rename(tmp,registryPath);}catch(e){console.error('Ticket created but registry persistence failed:',e.message);}
      return res.status(201).json(result);
    } catch(e){console.error('ServiceNow request error:',e.message);return res.status(502).json({error:'ServiceNow request failed. Check backend logs. Before retrying, check ServiceNow for a ticket to avoid duplicates.'});}
  };
  ticketQueue=ticketQueue.then(task,task).catch(e=>{console.error('Unexpected ticket error',e);if(!res.headersSent)res.status(500).json({error:'Ticket creation failed'});});
});
app.listen(Number(process.env.PORT||3001),'127.0.0.1',()=>console.log('AgentOps GCS ADC backend on http://127.0.0.1:'+String(process.env.PORT||3001)));
