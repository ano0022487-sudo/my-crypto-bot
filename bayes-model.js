'use strict';

/*
 * Bayesian calibration layer.
 *
 * Contract:
 *   - baseModel.bayesianProbability is the probability of baseModel.direction.
 *   - returned bayesPosterior is ALWAYS the probability of baseModel.direction.
 *   - returned upProbability/downProbability are ALWAYS probabilities of UP/DOWN.
 *   - modelProbability selected by the scanner therefore always means P(selected side).
 *
 * Posterior odds = prior odds × Bayes factor.
 * Beta(3,3) pseudo-counts keep small samples from producing extreme priors.
 */

function clamp(x,min,max){return Math.min(max,Math.max(min,x));}

function empiricalPrior(trades,direction){
  const rows=Array.isArray(trades)?trades:[];
  const wanted=direction==='UP'?'yes':'no';
  let wins=0,losses=0;
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

  // The base model probability is the probability of the selected direction.
  const evidenceProbability=clamp(Number(baseModel.bayesianProbability),0.05,0.95);
  const evidenceOdds=evidenceProbability/(1-evidenceProbability);
  const priorInfo=empiricalPrior(trades,direction);
  const priorOdds=priorInfo.prior/(1-priorInfo.prior);
  const posteriorOdds=priorOdds*evidenceOdds;
  const posterior=clamp(posteriorOdds/(1+posteriorOdds),0.05,0.95);

  // IMPORTANT: posterior is P(direction), not always P(UP).
  const upProbability=direction==='UP'?posterior:1-posterior;
  const downProbability=1-upProbability;
  const signals=Array.isArray(baseModel.signals)?baseModel.signals.filter(s=>!String(s).startsWith('Bayes posterior')).slice():[];
  signals.push(`Bayes prior ${(priorInfo.prior*100).toFixed(1)}% (${priorInfo.wins}W/${priorInfo.losses}L)`);
  signals.push(`Bayes factor ${evidenceOdds.toFixed(2)}x`);
  signals.push(`Bayes posterior ${(posterior*100).toFixed(1)}% ${direction}`);

  return{
    ...baseModel,
    upProbability,
    downProbability,
    bayesianProbability:posterior,
    bayesPrior:priorInfo.prior,
    bayesFactor:evidenceOdds,
    bayesPosterior:posterior,
    bayesDirection:direction,
    bayesSample:priorInfo.sample,
    signals
  };
}

module.exports={calibrateBayes};
