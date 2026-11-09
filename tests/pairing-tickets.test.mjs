import test from 'node:test';
import assert from 'node:assert/strict';
import {createPairingTickets} from '../integration/pairing-tickets.mjs';

test('配对凭据只能使用一次，错误凭据不能消费有效凭据',()=>{
 const tickets=createPairingTickets();const ticket=tickets.issue();
 assert.equal(tickets.consume(ticket.id,'wrong'),false);
 assert.equal(tickets.consume(ticket.id,ticket.secret),true);
 assert.equal(tickets.consume(ticket.id,ticket.secret),false);
});
test('配对凭据过期、尝试限制及数量上限',()=>{
 let clock=1000;const tickets=createPairingTickets({now:()=>clock,ttlMs:100,maxOutstanding:1,maxAttempts:2});
 const ticket=tickets.issue();assert.throws(()=>tickets.issue(),/PAIRING_LIMIT_REACHED/);
 assert.equal(tickets.consume(ticket.id,'wrong'),false);assert.equal(tickets.consume(ticket.id,'wrong'),false);
 assert.equal(tickets.consume(ticket.id,ticket.secret),false);
 const next=tickets.issue();clock+=100;assert.equal(tickets.consume(next.id,next.secret),false);
 const third=tickets.issue();tickets.revokeAll();assert.equal(tickets.consume(third.id,third.secret),false);
});
