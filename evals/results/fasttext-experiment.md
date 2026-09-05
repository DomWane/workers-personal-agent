# Static word vectors as a retriever — 2026-08-01

fastText Czech vectors (`cc.cs.300`, Common Crawl + Wikipedia, 300 dimensions), averaged into a
document vector and compared by cosine. The pre-transformer way to do semantic retrieval, run
here as the point of comparison for what a trained multilingual document embedder actually buys.

## Prediction, written before the run

fastText beats the substring baseline, lands near BM25 or slightly below, and loses clearly to
bge-m3. It does relatively better on the hard set than on the bulk set, because paraphrases need
semantics that lexical matching does not have.

## Result

| retriever           | bulk nDCG@10 | hard nDCG@10 |
| ------------------- | ------------ | ------------ |
| **fastText**        | **0.085**    | **0.057**    |
| keyword (substring) | 0.082        | 0.085        |
| BM25                | 0.178        | 0.222        |
| BM25 + stemming     | 0.238        | 0.288        |
| bge-m3              | 0.588        | 0.417        |

| comparison           | bulk                    | hard                    |
| -------------------- | ----------------------- | ----------------------- |
| fastText − BM25-stem | −0.153 [−0.255, −0.061] | −0.231 [−0.354, −0.114] |
| bge-m3 − fastText    | +0.503 [0.372, 0.629]   | +0.360 [0.221, 0.502]   |

**The prediction was mostly wrong.** It ties the substring baseline on the bulk set and _loses_ to
it on the hard set; it is far below BM25 rather than near it; and it does relatively worse on the
hard set, not better. Only "loses clearly to bge-m3" held.

The implementation was verified before drawing any conclusion: querying with a chunk's own text
returns that chunk at rank 1, 50/50 — the same self-retrieval check that validated BM25.

## Why, as far as this corpus can say

The likely cause is the asymmetry between a ten-word query and a two-hundred-word document once
both are mean-pooled. Averaging a document's word vectors averages away the parts that distinguish
it; the query does not undergo the same flattening. That is the weakness a trained document
embedder exists to fix.

**This is a hypothesis, not a finding.** The obvious test — do shorter targets score better? —
cannot be run here: the reply cap makes chunk lengths nearly uniform (median 1100 against 1234
characters for the two halves), so the comparison has no range to work with. It came out the other
way (0.032 short against 0.109 long), which is too weak a contrast on too narrow a spread to mean
anything either direction.

## Vocabulary coverage, and a download not made

The Czech vectors cover **93.1% of running text**; 15.8% of distinct words are missing, rising to
17.0% among the rarest fifth and falling to 5.7% among the most common. The missing words are
almost entirely **English**: `openclaw`, `payloads`, `runtask`, `captchas`, `paywalls`, `wafs`,
`datadome`. Czech inflection is handled — these vectors are trained on running text and hold the
surface forms. The gap is bilingualism, not morphology, which is also why falling back to the
stemmer recovers only 5.4% of the misses.

Aligned cross-lingual vectors (`wiki.cs.align` + `wiki.en.align`, 6.6 GB) would let Czech and
English words share one space and close that gap. They were not downloaded: fastText trails
bge-m3 by 0.360 on the hard set, and recovering 6.9% of tokens cannot close a gap of that size.
The same reasoning ruled out the 4.2 GB `.bin` subword model earlier — the OOV words are English,
so composing them from Czech n-grams would produce a shape without a meaning.

## What it is worth

As a retriever, nothing here. As a measurement, it sets the floor: the distance between static
word vectors and a trained multilingual embedder on this task is +0.360 nDCG@10 on realistic
queries, measured rather than assumed.

It was pooled like every other retriever before those numbers were quoted: its 84 candidates that
no other system surfaced were judged, and exactly one was relevant. Skipping that step would have
scored it against ground truth the other four built — the bias this project had already walked
into once with the stemmer.
