import type { Language } from './i18n.js';

const copy = {
  en: {
    title: 'Connect OpenAI', eyebrow: 'YOUR WORKSPACE · YOUR KEY', heading: 'Bring your own key.',
    intro: 'Power your knowledge bases and bots with your OpenAI account.', label: 'OpenAI API key',
    hint: 'The key goes directly to this server, outside your Telegram conversation. It is stored encrypted.',
    billing: 'Verification makes two small, billable API calls. Later indexing and bot answers are charged to this key.',
    button: 'Verify & connect', checking: 'Checking access…', done: 'Key connected. Return to the manager to continue.', close: 'Return to Telegram',
    missing: 'Open this form using the button in the manager.', error: 'Connection failed. Please try again.', link: 'Create a key in OpenAI',
    invalid: 'Enter an OpenAI API key starting with sk-.',
  },
  ru: {
    title: 'Подключить OpenAI', eyebrow: 'ВАШИ БОТЫ · ВАШ КЛЮЧ', heading: 'Подключите свой ключ.',
    intro: 'Ваш аккаунт OpenAI будет обеспечивать работу баз знаний и ботов.', label: 'API-ключ OpenAI',
    hint: 'Ключ отправляется напрямую на этот сервер, вне переписки Telegram. Он хранится в зашифрованном виде.',
    billing: 'Проверка выполнит два небольших платных API-запроса. Индексация и ответы ботов также оплачиваются с этого ключа.',
    button: 'Проверить и подключить', checking: 'Проверяем доступ…', done: 'Ключ подключён. Вернитесь в менеджер, чтобы продолжить.', close: 'Вернуться в Telegram',
    missing: 'Откройте эту форму кнопкой в менеджере.', error: 'Не удалось подключиться. Попробуйте ещё раз.', link: 'Создать ключ в OpenAI',
    invalid: 'Введите API-ключ OpenAI, начинающийся с sk-.',
  },
};

export function keyForm(language: Language, nonce: string) {
  const c = copy[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>${c.title} · Say AI</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--paper:#f4f2e9;--ink:#193c34;--muted:#4e6257;--line:#ccd3c7;--accent:#225f49;--surface:#faf9f3}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 Verdana,sans-serif}main{max-width:510px;margin:auto;padding:24px clamp(22px,6vw,40px) 42px}header{display:flex;justify-content:space-between;align-items:center;padding-bottom:18px;border-bottom:1px solid var(--line);font-size:13px}header strong{letter-spacing:-.6px;font-size:21px}header span{font-size:11px;letter-spacing:1px}.eyebrow{font-size:10px;letter-spacing:1.8px;margin:40px 0 14px}h1{font:normal clamp(35px,9vw,48px)/1.13 Georgia,serif;letter-spacing:-1.8px;margin:0 0 16px}p{margin:0 0 22px;color:var(--muted)}form{margin-top:34px}label{display:block;font-size:12px;font-weight:bold;margin-bottom:9px}input{width:100%;min-height:54px;border:1px solid var(--line);border-radius:3px;background:var(--surface);color:var(--ink);font:16px Verdana,sans-serif;padding:14px}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.hint{font-size:12px;margin-top:12px}.billing{font-size:12px;padding-top:19px;border-top:1px solid var(--line);margin-top:25px}button{width:100%;padding:15px 10px;border:0;border-radius:3px;background:var(--accent);color:#f6f6eb;font:600 14px Verdana,sans-serif;cursor:pointer;min-height:52px}button:disabled{opacity:.6;cursor:wait}a{display:inline-block;color:var(--ink);font-size:12px;text-underline-offset:4px;margin-top:20px}#status{font-size:13px;margin:18px 0 0;overflow-wrap:anywhere;color:var(--ink)}#status[data-error=true]{color:#b03927}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:root{--paper:#172c26;--ink:#e8eddf;--muted:#bacabd;--line:#456050;--accent:#417858;--surface:#20392f}#status[data-error=true]{color:#ffb9a5}}@media(prefers-reduced-motion:no-preference){button{transition:opacity .15s}button:hover{opacity:.88}}
@media(max-height:700px){.eyebrow{margin-top:20px}h1{font-size:32px}form{margin-top:22px}.billing{margin-top:18px;padding-top:14px}.hint{line-height:1.5}}
</style><script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js"></script></head><body><main><header><strong>Say AI</strong><span>OPENAI</span></header><div class="eyebrow">${c.eyebrow}</div><h1>${c.heading}</h1><p>${c.intro}</p>
<form id="form" autocomplete="off"><label for="key">${c.label}</label><input id="key" name="api-key" type="password" placeholder="sk-…" autocomplete="new-password" autocapitalize="none" spellcheck="false" maxlength="515" required aria-describedby="hint"><p id="hint" class="hint">${c.hint}</p><p class="billing">${c.billing}</p><button id="submit" type="submit">${c.button}</button></form><p id="status" role="status" aria-live="polite"></p><button id="close" hidden>${c.close}</button><a id="create-key" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">${c.link} ↗</a></main>
<script nonce="${nonce}">
const copy=${JSON.stringify(c).replace(/</g, '\\u003c')};
const app=window.Telegram?.WebApp;
app?.ready(); app?.expand();
const form=document.getElementById('form'),key=document.getElementById('key'),submit=document.getElementById('submit'),status=document.getElementById('status'),close=document.getElementById('close');
if(!app?.initData){submit.disabled=true;status.textContent=copy.missing;}
close.addEventListener('click',()=>app?.close());
form.addEventListener('submit',async event=>{
 event.preventDefault();if(submit.disabled)return;
 if(!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key.value.trim())){status.textContent=copy.invalid;status.dataset.error='true';return;}
 submit.disabled=true;submit.textContent=copy.checking;status.textContent='';status.dataset.error='false';
 let value=key.value.trim();key.value='';
 try{
  const result=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:value,initData:app.initData,language:${JSON.stringify(language)}}),signal:AbortSignal.timeout(40000)});
  value='';const body=await result.json().catch(()=>null);
  if(!result.ok){status.textContent=body?.error?.message||copy.error;status.dataset.error='true';submit.disabled=false;submit.textContent=copy.button;key.focus();return;}
  if(!body?.saved)throw new Error(copy.error);
  form.hidden=true;document.getElementById('create-key').hidden=true;close.hidden=false;status.textContent=copy.done;
 }catch(error){value='';status.textContent=copy.error;status.dataset.error='true';submit.disabled=false;submit.textContent=copy.button;key.focus();}
});
</script></body></html>`;
}
