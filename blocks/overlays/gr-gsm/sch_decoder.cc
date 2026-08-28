// gr-gsm builds sch.c with a C compiler, while the side-module helper invokes
// em++ for every source. Bring the upstream C-linkage declaration into scope
// before compiling its implementation so receiver_impl.cc and the definition
// agree on the unmangled decode_sch symbol.
#include "../../../gr-gsm/lib/receiver/sch.h"
#include "../../../gr-gsm/lib/decoding/sch.c"
