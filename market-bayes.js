'use strict';

function clamp(x,min,max){return Math.min(max,Math.max(min,x));}
function empiricalPrior(trades,direction){
  const rows=Array.isArray(trades)?trades:[];let wins=0,losses=0;const wanted=direction==='UP'?'yes':'no';
  for(const t of rows){if(String(t?.side||'').toLowerCase()!==wanted)continue;const pnl=Number(t?.pnl);if(pnl>0)wins++;else if(pnl<0)losses++;}
  const pseudo=3;const prior=(pseudo+wins)/(pseudo*2+wins+losses);return{prior,wins,losses,sample:wins+losses};
}
function calibrateMarketBayes(baseModel,trades,marketYesProb,marketNoProb){
  if(!baseModel||!baseModel.direction)return baseModel;
  const direction=String(baseModel.direction).toUpperCase()==='DOWN'?'DOWN':'UP';
  const rawEvidence=Number(baseModel.bayesianProbability);const evidenceProbability=Number.isFinite(rawEvidence)?clamp(rawEvidence,0.05,0.95):0.5;
  const technicalOdds=evidenceProbability/(1-evidenceProbability);const priorInfo=empiricalPrior(trades,direction);const priorOdds=priorInfo.prior/(1-priorInfo.prior);
  const marketProb=direction==='UP'?Number(marketYesProb):Number(marketNoProb);const safeMarket=Number.isFinite(marketProb)?clamp(marketProb,0.01,0.99):0.5;
  const marketOdds=safeMarket/(1-safeMarket);const technicalMarketGap=evidenceProbability-safeMarket;
  const marketAdjustment=clamp(1+technicalMarketGap*2.0,0.70,1.50);const scoreStrength=clamp((Number(baseModel.score||50)-50)/50,0,1);const confidenceAdjustment=1+(scoreStrength*0.20);
  const posteriorOdds=priorOdds*technicalOdds*marketAdjustment*confidenceAdjustment;const posterior=clamp(posteriorOdds/(1+posteriorOdds),0.05,0.95);
  const probability=direction==='UP'?posterior:1-posterior;const edge=probability-safeMarket;
  const signals=Array.isArray(baseModel.signals)?baseModel.signals.slice():[];
  signals.push(`Bayes prior ${(priorInfo.prior*100).toFixed(1)}% (${priorInfo.wins}W/${priorInfo.losses}L)`);
  signals.push(`Technical posterior ${(evidenceProbability*100).toFixed(1)}%`);signals.push(`Market ${(safeMarket*100).toFixed(1)}%`);signals.push(`Market-adjust ${marketAdjustment.toFixed(2)}x`);signals.push(`Bayes posterior ${(posterior*100).toFixed(1)}%`);
  return{...baseModel,upProbability:probability,downProbability:1-probability,bayesianProbability:posterior,bayesPrior:priorInfo.prior,bayesFactor:technicalOdds,bayesPosterior:posterior,bayesSample:priorInfo.sample,marketProbability:safeMarket,marketOdds,marketAdjustment,technicalMarketGap,bayesEdge:edge,expectedValue:edge,signals};
}
module.exports={calibrateMarketBayes};
