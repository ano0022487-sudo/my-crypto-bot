'use strict';

/*
 * Bayesian calibration layer for the event-contract model.
 * The base model supplies a likelihood-driven probability using current market evidence.
 * This module supplies the empirical prior from closed trades, then applies:
 * posterior odds = prior odds × Bayes factor.
 *
 * A Beta(3,3) pseudo-prior is used to keep a small trade history from producing
 * an extreme prior. Only closed trades matching the requested direction are used.
 */

function clamp(x,min,max){return Math.min(max,Math.max(min,x));}

function empiricalPrior(trades,direction){
  const rows=Array.isArray(trades)?trades:[];
  let wins=0,losses=0;
  const wanted=direction==='UP'?'yes':'no';
  for(const t of rows){
    if(String(t?.side||'').toLowerCase()!==wanted)continue;
    const pnl=Number(t?.pnl);
    if(pnl>0)wins++;
    else if(pnl<0)losses++;
  }
  const pseudo=3;
  const prior=(pseudo+wins)/(pseudo*2+wins+losses);
  return{prior,wins,losses,sample:wins+losses};
}

function calibrateBayes(baseModel,trades){
  if(!baseModel||!baseModel.direction)return baseModel;
  const direction=String(baseModel.direction).toUpperCase()==='DOWN'?'DOWN':'UP';
  const rawEvidence=Number(baseModel.bayesianProbability);
  const evidenceProbability=Number.isFinite(rawEvidence)?clamp(rawEvidence,0.05,0.95):0.5;
  const bayesFactor=evidenceProbability/(1-evidenceProbability);
  const priorInfo=empiricalPrior(trades,direction);
  const priorOdds=priorInfo.prior/(1-priorInfo.prior);
  const posteriorOdds=priorOdds*bayesFactor;
  const posterior=clamp(posteriorOdds/(1+posteriorOdds),0.05,0.95);
  const probability=direction==='UP'?posterior:1-posterior;
  const signals=Array.isArray(baseModel.signals)?baseModel.signals.slice():[];
  signals.push(`Bayes prior ${ (priorInfo.prior*100).toFixed(1)}% (${priorInfo.wins}W/${priorInfo.losses}L)`);
  signals.push(`Bayes factor ${bayesFactor.toFixed(2)}x`);
  signals.push(`Bayes posterior ${(posterior*100).toFixed(1)}%`);
  return{
    ...baseModel,
    upProbability:probability,
    downProbability:1-probability,
    bayesianProbability:posterior,
    bayesPrior:priorInfo.prior,
    bayesFactor,
    bayesPosterior:posterior,
    bayesSample:priorInfo.sample,
    signals
  };
}

module.exports={calibrateBayes};
