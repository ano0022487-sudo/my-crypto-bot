'use strict';

function finite(v){return Number.isFinite(Number(v))?Number(v):null;}
function pctChange(current,base){if(current==null||base==null||base===0)return null;return ((current-base)/Math.abs(base))*100;}
function stats(values){const a=values.map(Number).filter(Number.isFinite);if(!a.length)return {count:0,mean:null,median:null,std:null};a.sort((x,y)=>x-y);const mean=a.reduce((s,x)=>s+x,0)/a.length;const median=a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;const variance=a.reduce((s,x)=>s+(x-mean)**2,0)/a.length;return {count:a.length,mean,median,std:Math.sqrt(variance)};}
function zscore(value,baseline){const s=stats(baseline);return value==null||s.std===null||s.std===0?null:(value-s.mean)/s.std;}
function anomalySeverity(z,thresholds){if(z==null)return '資料不足';const a=Math.abs(z);if(a>=thresholds.extreme)return '極端異常';if(a>=thresholds.high)return '高異常';if(a>=thresholds.elevated)return '偏高';return '正常';}
function classifyStructure(priceChange,oiChange){if(priceChange==null||oiChange==null)return '資料不足';if(priceChange>0&&oiChange>0)return '上漲 / OI 增加';if(priceChange>0&&oiChange<0)return '上漲 / OI 減少';if(priceChange<0&&oiChange>0)return '下跌 / OI 增加';if(priceChange<0&&oiChange<0)return '下跌 / OI 減少';return '持平 / OI 無變化';}
function cvdDelta(trades){let v=0;for(const t of trades||[]){const size=finite(t.size);if(size==null)continue;if(t.side==='buy')v+=size;else if(t.side==='sell')v-=size;}return v;}
function cumulativeCvd(trades){let total=0;return (trades||[]).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)).map(t=>{const d=cvdDelta([t]);total+=d;return {...t,cvd:total};});}
function favorableAdverse(entry,prices){const r=prices.map(p=>pctChange(p,entry)).filter(v=>v!=null);if(!r.length)return {mfe:null,mae:null};return {mfe:Math.max(...r),mae:Math.min(...r)};}
function eventResearch(entry,prices){const returns=prices.map(p=>pctChange(p,entry));const path=prices.filter(p=>p!=null);const {mfe,mae}=favorableAdverse(entry,path);return {t5Return:returns[0]??null,t15Return:returns[1]??null,t1hReturn:returns[2]??null,t4hReturn:returns[3]??null,t24hReturn:returns[4]??null,mfe,mae};}
function outcomeStats(rows,field){const vals=rows.map(r=>finite(r[field])).filter(v=>v!=null);if(!vals.length)return {sampleSize:0,averageReturn:null,medianReturn:null,positiveOutcomePct:null,negativeOutcomePct:null};const s=stats(vals);return {sampleSize:s.count,averageReturn:s.mean,medianReturn:s.median,positiveOutcomePct:vals.filter(v=>v>0).length/vals.length*100,negativeOutcomePct:vals.filter(v=>v<0).length/vals.length*100};}
module.exports={finite,pctChange,stats,zscore,anomalySeverity,classifyStructure,cvdDelta,cumulativeCvd,favorableAdverse,eventResearch,outcomeStats};
