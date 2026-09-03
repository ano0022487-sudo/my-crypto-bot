'use strict';
function finite(v){return Number.isFinite(Number(v))?Number(v):null;}
function pctChange(current,base){if(current==null||base==null||base===0)return null;return ((current-base)/Math.abs(base))*100;}
function stats(values){const a=values.map(Number).filter(Number.isFinite);if(!a.length)return {count:0,mean:null,median:null,std:null};a.sort((x,y)=>x-y);const mean=a.reduce((s,x)=>s+x,0)/a.length;const median=a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;const variance=a.reduce((s,x)=>s+(x-mean)**2,0)/a.length;return {count:a.length,mean,median,std:Math.sqrt(variance)};}
function zscore(value,baseline){const s=stats(baseline);return value==null||s.std===null||s.std===0?null:(value-s.mean)/s.std;}
function anomalySeverity(z,thresholds){if(z==null)return '資料不足';const a=Math.abs(z);if(a>=thresholds.extreme)return '極端異常';if(a>=thresholds.high)return '高異常';if(a>=thresholds.elevated)return '偏高';return '正常';}
module.exports={finite,pctChange,stats,zscore,anomalySeverity};
