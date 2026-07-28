# Software-emulated double-mapped buffers

WebAssembly cannot map one physical allocation at two virtual addresses. The WASM
runtime therefore uses `vmcircbuf_emulated`, which allocates two adjacent physical
copies of every logical N-byte stream buffer:

```text
[A, A+N)       first copy
[A+N, A+2N)    second copy
```

Blocks receive the same contiguous pointers and the same circular indices as they
do with GNU Radio's native `buffer_double_mapped`. A call to `general_work()` may
therefore read or write straight across the seam.

The copies are made coherent when `buffer::update_write_pointer()` commits produced
items. The commit runs under the buffer mutex and before the write index advances:

- a write wholly in the first half is copied to the corresponding second-half range;
- for a wrapping write, the first-half tail is copied to the mirror tail and the
  second-half prefix is copied back to the first-half prefix.

Readers cannot observe the new item count until synchronization is complete. Native
`vmcircbuf` implementations use the same commit hook, but it is a no-op because their
virtual aliases are already coherent.

## Tradeoffs

- Stream buffers use 2N physical bytes instead of N.
- Every produced byte is copied once in the correctness-first implementation.
- The scheduler, history, tags, readers, and ring-index behavior stay on the normal
  double-mapped path.
- The single-mapped realignment callbacks are not involved, avoiding their WASM
  wrap-boundary stalls and wakeup races.

`FORCE_SINGLE_MAPPED` remains available as an explicit fallback/debug build, but it
is not used by the normal WASM runner.

## Verification

The emulated factory is exercised by `qa_vmcircbuf`, including a write that crosses
the seam. `qa_buffer` also reruns its wrap-around test with the emulated factory,
which verifies that synchronization occurs through the normal write-pointer commit
API rather than through backend-specific calls.
