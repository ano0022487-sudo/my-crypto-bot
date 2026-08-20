'use strict';

/*
 * Final Bayesian calibration for the selected UP/DOWN direction.
 *
 * The base model provides P(direction | technical evidence) using a 50/50
 * technical prior. This module then applies the empirical historical prior
 * and a market-price likelihood adjustment. The returned upProbability and
 * downProbability are always absolute UP/DOWN probabilities; the scanner's
 * modelProb is therefore always P(selected side).
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

function calibrateMarketBayes(baseModel,trades,marketYesProb,marketNoProb){
  if(!baseModel||!baseModel.direction)return baseModel;
  const direction=String(baseModel.direction).toUpperCase()==='DOWN'?'DOWN':'UP';

  // baseModel.bayesianProbability is P(direction | technical evidence).
  const technicalProbability=clamp(Number(baseModel.bayesianProbability),0.05,0.95);
  const technicalOdds=technicalProbability/(1-technicalProbability);
  const priorInfo=empiricalPrior(trades,direction);
  const priorOdds=priorInfo.prior/(1-priorInfo.prior);

  // Market price is the observed probability for the SAME direction.
  const rawMarket=direction==='UP'?Number(marketYesProb):Number(marketNoProb);
  const marketProbability=Number.isFinite(rawMarket)?clamp(rawMarket,0.01,0.99):0.5;
  const marketOdds=marketProbability/(1-marketProbability);

  // Because the technical model was calibrated from a neutral 50% prior,
  // technical odds act as the evidence/Bayes factor. Historical prior odds are
  // then combined with the evidence. Market price is used only as a bounded
  // calibration factor so it cannot manufacture a 0%/100% posterior.
  const technicalMarketGap=technicalProbability-marketProbability;
  const marketAdjustment=clamp(1+technicalMarketGap*2.0,0.70,1.50);
  const scoreStrength=clamp((Number(baseModel.score||50)-50)/50,0,1);
  const confidenceAdjustment=1+(scoreStrength*0.20);
  const posteriorOdds=priorOdds*technicalOdds*marketAdjustment*confidenceAdjustment;
  const posterior=clamp(posteriorOdds/(1+posteriorOdds),0.05,0.95);

  // posterior is P(direction). Convert it to absolute UP/DOWN probabilities.
  const upProbability=direction==='UP'?posterior:1-posterior;
  const downProbability=1-upProbability;
  const selectedProbability=direction==='UP'?upProbability:downProbability;
  const edge=selectedProbability-marketProbability;

  // Remove the old generic Bayes label so every log has one unambiguous final
  // Bayesian posterior and one explicitly named technical posterior.
  const signals=Array.isArray(baseModel.signals)
    ?baseModel.signals.filter(s=>!String(s).startsWith('Bayes posterior')).slice()
    :[];
  signals.push(`Bayes prior ${(priorInfo.prior*100).toFixed(1)}% (${priorInfo.wins}W/${priorInfo.losses}L)`);
  signals.push(`Technical posterior ${(technicalProbability*100).toFixed(1)}% ${direction}`);
  signals.push(`Market ${(marketProbability*100).toFixed(1)}% ${direction}`);
  signals.push(`Market-adjust ${marketAdjustment.toFixed(2)}x`);
  signals.push(`Bayes posterior ${(posterior*100).toFixed(1)}% ${direction}`);
  signals.push(`Final P(${direction}) ${(selectedProbability*100).toFixed(1)}%`);

  return{
    ...baseModel,
    upProbability,
    downProbability,
    bayesianProbability:posterior,
    bayesPrior:priorInfo.prior,
    bayesFactor:technicalOdds,
    bayesPosterior:posterior,
    bayesDirection:direction,
    bayesSample:priorInfo.sample,
    marketProbability,
    marketOdds,
    marketAdjustment,
    technicalMarketGap,
    bayesEdge:edge,
    expectedValue:edge,
    signals
  };
}

module.exports={calibrateMarketBayes};
