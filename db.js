let AUTH_TOKEN = localStorage.getItem('cpm_token') || null;
function setAuthToken(token){ AUTH_TOKEN = token; if(token) localStorage.setItem('cpm_token', token); else localStorage.removeItem('cpm_token'); }
function getAuthToken(){ return AUTH_TOKEN; }

const SUPA_URL='https://sldahhdbvcxdlqdhmsjd.supabase.co';
const SUPA_KEY='sb_publishable_ZGELlV5vw7QFvva8_8NGcA_pQplXd46';

async function db(table,method='GET',body=null,filters=''){
  const res=await fetch(`${SUPA_URL}/rest/v1/${table}${filters}`,{
    method,
    headers:{
      'Content-Type':'application/json',
      'apikey':SUPA_KEY,
      'Authorization':'Bearer '+SUPA_KEY,
      'Prefer':method==='POST'?'return=representation':''
    },
    body:body?JSON.stringify(body):null
  });
  if(!res.ok){const e=await res.text();console.error('DB error:',e);return null;}
  const text=await res.text();
  return text?JSON.parse(text):null;
}

async function loadFromDB(){
const [lots,vals,passes,sess,profiles,compCodes,invoices]=await Promise.all([
    db('lots','GET',null,'?select=*'),
    db('validations','GET',null,'?select=*'),
    db('passes','GET',null,'?select=*&order=created_at.desc'),
    db('sessions','GET',null,'?select=*&order=created_at.desc&limit=200'),
    db('profiles','GET',null,'?select=*'),
    db('comp_codes','GET',null,'?select=*&order=created_at.desc'),
    db('invoices','GET',null,'?select=*&order=created_at.desc'),
  ]);
  if(lots){
    S.lots={};
    lots.forEach(l=>{
      S.lots[l.id]={
        ...l,
        rates:l.rates||{},
        fees:l.fees||{},
        pricing:l.pricing||{},
        monthlyselfsrv:l.monthlyselfsrv
      };
    });
  }
  if(vals){
    S.vals={};
    vals.forEach(v=>{
      S.vals[v.id]={
        id:v.id,name:v.name,code:v.code,lotId:v.lot_id,
        lotIds:v.lot_ids||[v.lot_id],
        business_token:v.business_token||null,
        previous_codes:v.previous_codes||[],
        billingEmail:v.billing_email||null,
        billingContact:v.billing_contact||null,
        monthlyRate:v.monthly_rate||0,
        billingMethod:v.billing_method||'flat',
        type:v.type,discountPct:v.discount_pct,discountAmt:v.discount_amt,
        maxHours:v.max_hours,active:v.active,notes:v.notes
      };
    });
  }
  if(passes){
    S.passes=passes.map(p=>({
      id:p.id,name:p.name,email:p.email,lotId:p.lot_id,status:p.status,
      startDate:new Date(p.start_date),
      nextBillDate:p.next_bill_date?new Date(p.next_bill_date):null,
      canceledOn:p.canceled_on?new Date(p.canceled_on):null,
      monthlyAmount:p.monthly_amount,totalBilled:p.total_billed,
      inviteToken:p.invite_token,
      plate:p.plate||null,
      billedAt:p.billed_at||null
    }));
  }
  if(profiles){
    S.users=profiles.map(p=>({
      id:p.id,name:p.name,role:p.role,active:p.active,
      username:p.name.toLowerCase().replace(/\s+/g,'.')
    }));
  }
  if(compCodes){
    S.compCodes=compCodes;
  }
  if(invoices){
    S.invoices=invoices;
  }
  if(sess){
    S.sess=sess.map(s=>({
      id:s.id,plate:s.plate,type:s.type,rate:s.rate,
      start:s.start_time,duration:s.duration,paid:s.paid,
      pkch:s.pkch,sfee:s.sfee,vehicle:s.vehicle,phone:s.phone,
      smsSent:s.sms_sent,receiptSent:s.receipt_sent,
      lotId:s.lot_id,valId:s.val_id,
      paymentIntentId:s.payment_intent_id||null,
      captured:s.captured||false
    }));
  }
}

async function loginUser(username,password){
  const res=await db('users','GET',null,`?username=eq.${username}&password=eq.${password}&active=eq.true&select=*`);
  return res&&res.length>0?res[0]:null;
}

async function saveSession(sess){
  return db('sessions','POST',{
    id:sess.id,plate:sess.plate,type:sess.type,rate:sess.rate,
    start_time:sess.start,duration:sess.duration,paid:sess.paid,
    pkch:sess.pkch,sfee:sess.sfee,vehicle:sess.vehicle,phone:sess.phone,
    sms_sent:sess.smsSent,receipt_sent:sess.receiptSent||false,
    email:sess.email||'',lot_id:sess.lotId,val_id:sess.valId||null,
    payment_intent_id:sess.paymentIntentId||null,captured:sess.captured||false
  });
}

async function saveLotDB(lot){
  const exists=await db('lots','GET',null,`?id=eq.${lot.id}&select=id`);
  const body={
    id:lot.id,name:lot.name,zone:lot.zone,address:lot.address,
    open:lot.open,rates:lot.rates,monthlyselfsrv:lot.monthlyselfsrv,
    fees:lot.fees,pricing:lot.pricing
  };
  if(exists&&exists.length>0)return db('lots','PATCH',body,`?id=eq.${lot.id}`);
  return db('lots','POST',body);
}

async function deleteLotDB(id){
  return db('lots','DELETE',null,`?id=eq.${id}`);
}

async function saveValDB(val){
  const exists=await db('validations','GET',null,`?id=eq.${val.id}&select=id`);
  const body={
    id:val.id,name:val.name,code:val.code,lot_id:val.lotIds[0]||val.lotId,
    lot_ids:val.lotIds,type:val.type,
    discount_pct:val.discountPct,discount_amt:val.discountAmt,
    max_hours:val.maxHours,active:val.active,notes:val.notes,
    business_token:val.business_token||null,
    previous_codes:val.previous_codes||[],
    billing_email:val.billingEmail||null,
    billing_contact:val.billingContact||null,
    monthly_rate:val.monthlyRate||0,
    billing_method:val.billingMethod||'flat'
  };
  if(exists&&exists.length>0)return db('validations','PATCH',body,`?id=eq.${val.id}`);
  return db('validations','POST',body);
}

async function deleteValDB(id){
  return db('validations','DELETE',null,`?id=eq.${id}`);
}

async function savePassDB(pass){
  return db('passes','POST',{
    id:pass.id,name:pass.name,email:pass.email,lot_id:pass.lotId,
    status:pass.status,start_date:pass.startDate,next_bill_date:pass.nextBillDate,
    canceled_on:pass.canceledOn,monthly_amount:pass.monthlyAmount,
    total_billed:pass.totalBilled,invite_token:pass.inviteToken,
    custom_price:pass.custom_price||null,
    signup_token:pass.signup_token||null,
    lot_name:pass.lot_name||null,
    holder_name:pass.holder_name||null,
    plate:pass.plate||null
  });
}

async function updatePassDB(id,updates){
  return db('passes','PATCH',updates,`?id=eq.${id}`);
}

async function saveUserDB(user){
  const exists=await db('profiles','GET',null,`?id=eq.${user.id}&select=id`);
  const body={id:user.id,name:user.name,role:user.role,active:user.active};
  if(exists&&exists.length>0)return db('profiles','PATCH',body,`?id=eq.${user.id}`);
  return db('profiles','POST',body);
}

async function deleteUserDB(id){
  return db('profiles','DELETE',null,`?id=eq.${id}`);
}

async function createPaymentIntent(amount, description, sessionId){
  const res = await fetch(`${SUPA_URL}/functions/v1/stripe-payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (getAuthToken() || SUPA_KEY),
    },
    body: JSON.stringify({ amount, description, sessionId })
  });
return res.json();
}

async function capturePayment(paymentIntentId, amount){
  const res = await fetch(`${SUPA_URL}/functions/v1/stripe-capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (getAuthToken() || SUPA_KEY),
    },
    body: JSON.stringify({ paymentIntentId, amount })
  });
  return res.json();
}

async function createStaffAccount(email, password, name, role){
  const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNsZGFoaGRidmN4ZGxxZGhtc2pkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwMDMzNSwiZXhwIjoyMDk3NDc2MzM1fQ.UGRnp4IkwYtRu2gJ9TLf-MdXwUDc6P9yUBtu3O8aywU';
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': 'Bearer ' + SERVICE_KEY
    },
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  if(!res.ok){ const e=await res.json(); console.error('Auth error:',e); return null; }
  const data = await res.json();
  if(!data.id) return null;
  await db('profiles','POST',{ id:data.id, name, role, active:true });
  return data;
}

async function supabaseLogin(email, password){
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY
    },
    body: JSON.stringify({ email, password })
  });
  if(!res.ok) return null;
  return res.json(); // returns { access_token, user, ... }
}

async function supabaseSignOut(accessToken){
  await fetch(`${SUPA_URL}/auth/v1/logout`, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + accessToken
    }
  });
}

async function getProfile(userId, accessToken){
  const res = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${userId}&select=*`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + accessToken
    }
  });
  if(!res.ok) return null;
  const data = await res.json();
  return data && data.length > 0 ? data[0] : null;
}

async function sendSMS(to, message){
  const res = await fetch(`${SUPA_URL}/functions/v1/send-sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (getAuthToken() || SUPA_KEY),
    },
    body: JSON.stringify({ to, message })
  });
  return res.json();
}

async function sendEmail(to, subject, html){
  const res = await fetch(`${SUPA_URL}/functions/v1/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (getAuthToken() || SUPA_KEY),
    },
    body: JSON.stringify({ to, subject, html })
  });
  return res.json();
}

async function supabaseGetSession(){
  const token = getAuthToken();
  if(!token) return null;
  const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + token
    }
  });
  if(!res.ok){ setAuthToken(null); return null; }
  const user = await res.json();
  return { access_token: token, user };
}

function saveTemplatesToLocal(){
  localStorage.setItem('cpm_sms_tmpl', S.smsTmpl);
  localStorage.setItem('cpm_receipt_tmpl', S.receiptTmpl);
  localStorage.setItem('cpm_invite_tmpl', S.inviteTmpl);
  localStorage.setItem('cpm_invite_subj', S.inviteSubject);
}

function loadTemplatesFromLocal(){
  const sms = localStorage.getItem('cpm_sms_tmpl');
  const receipt = localStorage.getItem('cpm_receipt_tmpl');
  const invite = localStorage.getItem('cpm_invite_tmpl');
  const subj = localStorage.getItem('cpm_invite_subj');
  if(sms) S.smsTmpl = sms;
  if(receipt) S.receiptTmpl = receipt;
  if(invite) S.inviteTmpl = invite;
  if(subj) S.inviteSubject = subj;
}

async function loadCompCodes(){
  const codes = await db('comp_codes','GET',null,'?select=*&order=created_at.desc');
  if(codes) S.compCodes = codes;
}

async function saveCompCode(code){
  return db('comp_codes','POST',code);
}

async function deleteCompCode(id){
  return db('comp_codes','DELETE',null,`?id=eq.${id}`);
}

async function useCompCode(id, plate){
  return db('comp_codes','PATCH',{used_at:new Date().toISOString(),used_by_plate:plate},`?id=eq.${id}`);
}