"""Continuation payload tests; no providers or private messages."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT / "server-patches/creator-revenue-r366"))
from homer_generation_intent import apply_continuation_intent, continuation_instruction, CONTINUATION_INSTRUCTION


class GenerationIntentTests(unittest.TestCase):
    def test_continue_has_an_explicit_final_user_instruction_not_old_question(self):
        messages=[{"role":"user","content":"合成场景问题"},{"role":"assistant","content":"合成已完成段落"}]
        result=apply_continuation_intent(messages,{"homer_generation_type":"continue"})
        self.assertEqual(result[-1],{"role":"user","content":CONTINUATION_INSTRUCTION})
        self.assertEqual(messages[-1]["role"],"assistant")
        self.assertEqual(len(result),3)

    def test_anthropic_existing_continue_tail_is_not_duplicated(self):
        messages=[{"role":"assistant","content":"合成段落"},{"role":"user","content":CONTINUATION_INSTRUCTION}]
        self.assertEqual(apply_continuation_intent(messages,{"homer_generation_type":"continue"}),messages)

    def test_ordinary_rewrite_and_quiet_keep_their_existing_prompt(self):
        messages=[{"role":"user","content":"合成问题"}]
        for kind in [None,"normal","regenerate","quiet","impersonate","swipe"]:
            body={} if kind is None else {"homer_generation_type":kind}
            self.assertIs(apply_continuation_intent(messages,body),messages)
            self.assertEqual(continuation_instruction(body),"")

    def test_invalid_or_user_text_inferred_type_is_not_accepted(self):
        for value in [True,1,{},"next","继续"]:
            with self.assertRaises(ValueError):
                apply_continuation_intent([],{"homer_generation_type":value})
        self.assertEqual(continuation_instruction({"content":"继续"}),"")


if __name__ == "__main__":
    unittest.main()
