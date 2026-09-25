const test = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('./holder-age');
const { firstReceipt, getFirstReceipt, enrichHolderHistory } = require('./holder-history');
const now = 1800000000, day = 86400;
test('holder tiers use exact day boundaries and reject missing or future dates', () => {
  for (const [days, label] of [[0,'Fresh holder'],[29,'Fresh holder'],[30,'Established holder'],[179,'Established holder'],[180,'Long-term holder'],[364,'Long-term holder'],[365,'Diamond holder']]) {
    assert.equal(classify(now - days * day, now).label, label);
  }
  for (const invalid of [null, undefined, 0, -1, now + 1, String(now)]) assert.equal(classify(invalid, now).days, null);
});
test('first receipt ignores zero amounts and outgoing transfers', () => {
  const token = '0x0c03ce270b4826ec62e7dd007f0b716068639f7b';
  const row = (to, value, timeStamp) => ({to, value, timeStamp, blockNumber: '10', contractAddress: token});
  assert.equal(firstReceipt([row('a','0',100),row('b','5',101),row('a','5',102)],'a',10,200),102);
  assert.equal(firstReceipt([row('a','0',100)],'a',10,200),null);
  assert.throws(()=>firstReceipt([row('a','1',201)],'a',10,200));
});
test('all history pages are read before assigning an age; newer-than-snapshot transfers are excluded', async t => {
  const token = '0x0c03ce270b4826ec62e7dd007f0b716068639f7b';
  const row = (block, time, value='5') => ({ block_number:block, timestamp:new Date(time*1000).toISOString(), token:{address_hash:token}, to:{hash:'a'}, total:{value} });
  let calls = 0;
  t.mock.method(global, 'fetch', async url => {
    calls++;
    if (calls === 2) assert.match(String(url), /block_number=10/);
    return new Response(JSON.stringify(calls === 1
      ? {items:[row(21,201),row(15,150)],next_page_params:{block_number:10,index:1}}
      : {items:[row(9,90),row(8,80,'0')],next_page_params:null}));
  });
  assert.deepEqual(await getFirstReceipt('a',20,200),{firstReceived:90});
  assert.equal(calls,2);
});
test('an older receipt can prove Diamond without pretending to know the first date', async t => {
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({items:[{
    block_number:10, timestamp:new Date((now-400*day)*1000).toISOString(),
    token:{address_hash:'0x0c03ce270b4826ec62e7dd007f0b716068639f7b'},to:{hash:'a'},total:{value:'5'}
  }],next_page_params:{block_number:9,index:0}})));
  assert.deepEqual(await getFirstReceipt('a',20,now),{receivedBy:now-400*day});
});
test('an exhausted refresh budget preserves verified dates without blocking balance updates', async t => {
  t.mock.method(global, 'fetch', () => { throw new Error('Should not fetch'); });
  const address = '0x'+'1'.repeat(40), other = '0x'+'2'.repeat(40);
  const payload = {timestamp:now, block:20, candidates:[{address:other}]};
  await enrichHolderHistory(payload,{firstReceived:{[address]:now-100*day}},()=>{},0);
  assert.equal(payload.firstReceived[address],now-100*day);
  assert.equal(payload.firstReceived[other],undefined);
});
