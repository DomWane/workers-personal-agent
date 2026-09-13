from embed.rerank_precompute import candidate_hash, candidates_for


def test_candidates_union_both_lists_dense_first_without_duplicates() -> None:
    assert candidates_for(['a', 'b'], ['b', 'c']) == ['a', 'b', 'c']


def test_candidate_hash_is_the_typescript_one_so_existing_rows_still_match() -> None:
    assert candidate_hash(['a', 'b']) == '7e18f737311b2dc3'
    assert candidate_hash(['b', 'a']) != candidate_hash(['a', 'b'])
