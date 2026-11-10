import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import registryLoader from 'prismarine-registry';
import itemLoader from 'prismarine-item';
import injectCreative from 'mineflayer/lib/plugins/creative.js';
import { installCreativeItemAdapter } from '../src/agent/library/creative_items.js';

const registry = registryLoader('1.21.6');
const Item = itemLoader(registry);
const sand = registry.itemsByName.sand.id;
assert.throws(() => Item.toNotch({type:sand,count:64,metadata:0}), /length/);
assert.throws(() => Item.toNotch({type:sand,count:64,components:[]}), /length/);
function mock() {
    const inventory = new EventEmitter(); inventory.slots = Array(46).fill(null);
    const writes = [];
    const bot = {registry,inventory,supportFeature:()=>false,_client:{write(name,packet) {
        writes.push({name,packet});
        queueMicrotask(() => {
            const old = inventory.slots[packet.slot];
            const next = Item.fromNotch(packet.item);
            inventory.slots[packet.slot] = next;
            inventory.emit(`updateSlot:${packet.slot}`, old, next);
        });
    }}};
    injectCreative(bot);
    return {bot,writes};
}
// Reproduce the follow-up busy-slot failure in the unwrapped installed plugin.
const old = mock();
await assert.rejects(old.bot.creative.setInventorySlot(36,{type:sand,count:64}), /length/);
await assert.rejects(old.bot.creative.setInventorySlot(36,new Item(sand,64)), /again/);
const {bot,writes} = mock(); installCreativeItemAdapter(bot);
const wrapper=bot.creative.setInventorySlot; installCreativeItemAdapter(bot); assert.equal(wrapper,bot.creative.setInventorySlot);
for (const [slot,descriptor] of [[36,{type:sand,count:64,metadata:0}],[37,{type:sand,count:64,nbt:null}],[38,{type:sand,count:64,components:[]}]]) {
    await bot.creative.setInventorySlot(slot,descriptor);
    assert.equal(bot.inventory.slots[slot].name,'sand');
    assert.equal(writes.at(-1).packet.item.removedComponentCount,0);
}
await assert.rejects(bot.creative.setInventorySlot(39,{type:sand,count:64,components:'bad'}), /must be arrays/);
await bot.creative.setInventorySlot(39,new Item(sand,32));
assert.equal(bot.inventory.slots[39].count,32);
await bot.creative.setInventorySlot(39,null); assert.equal(bot.inventory.slots[39],null);
console.log('PASS: reproduced both root errors; all three generated item shapes, real Items, same-slot retry after invalid input, clearing and idempotent install passed with installed Mineflayer plugin.');
