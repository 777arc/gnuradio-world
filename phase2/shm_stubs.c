/* SysV shared-memory stubs for WASM/Emscripten. GNU Radio's double-mapped
 * vmcircbuf backend (vmcircbuf_sysv_shm) references these, but with
 * -DFORCE_SINGLE_MAPPED the double-mapped path is never taken at runtime, so
 * these are link-satisfying no-ops that fail cleanly if ever called. */
#include <errno.h>
#include <stddef.h>
int   shmget(int key, size_t size, int shmflg) { (void)key;(void)size;(void)shmflg; errno = ENOSYS; return -1; }
void* shmat (int shmid, const void* addr, int flg) { (void)shmid;(void)addr;(void)flg; errno = ENOSYS; return (void*)-1; }
int   shmdt (const void* addr) { (void)addr; errno = ENOSYS; return -1; }
int   shmctl(int shmid, int cmd, void* buf) { (void)shmid;(void)cmd;(void)buf; errno = ENOSYS; return -1; }
