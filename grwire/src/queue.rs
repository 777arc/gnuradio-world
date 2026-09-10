//! The one place a frame is dropped.
//!
//! This is the load-bearing half of the backpressure design. A bounded queue
//! that **drops the oldest** frame when it is full, because for a live radio the
//! freshest samples are the valuable ones and a backlog is just latency nobody
//! asked for. The alternative -- letting the socket's own write buffer absorb
//! the backlog -- is bufferbloat: it turns a 30 ms link into seconds of lag that
//! look exactly like a broken flowgraph.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::Notify;

pub struct Frame {
    /// Header and payload, already serialised. The writer patches the flags
    /// field in place when a drop happened before this frame.
    pub bytes: Vec<u8>,
    pub samples: u32,
}

pub struct FrameQueue {
    inner: Mutex<VecDeque<Frame>>,
    capacity: usize,
    notify: Notify,
    closed: AtomicBool,
}

impl FrameQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(VecDeque::with_capacity(capacity.max(1))),
            capacity: capacity.max(1),
            notify: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Push a frame, displacing the oldest if the queue is full.
    ///
    /// Returns the frame that was displaced, so the caller can count the loss
    /// against the right layer -- this type deliberately does not own a counter,
    /// because the same queue shape is used at more than one layer.
    pub fn push(&self, frame: Frame) -> Option<Frame> {
        let displaced = {
            let mut queue = self.inner.lock().unwrap();
            let displaced = if queue.len() >= self.capacity {
                queue.pop_front()
            } else {
                None
            };
            queue.push_back(frame);
            displaced
        };
        self.notify.notify_one();
        displaced
    }

    /// Wait for the next frame. `None` once the queue is closed and drained.
    pub async fn pop(&self) -> Option<Frame> {
        loop {
            if let Some(frame) = self.inner.lock().unwrap().pop_front() {
                return Some(frame);
            }
            if self.closed.load(Ordering::Acquire) {
                return None;
            }
            self.notify.notified().await;
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn frame(tag: u8) -> Frame {
        Frame {
            bytes: vec![tag],
            samples: 1,
        }
    }

    #[test]
    fn drops_the_oldest_so_latency_stays_bounded() {
        let queue = FrameQueue::new(2);
        assert!(queue.push(frame(1)).is_none());
        assert!(queue.push(frame(2)).is_none());
        // Full: the third push must displace frame 1, not refuse frame 3. A
        // live radio's newest samples are the ones worth keeping.
        let displaced = queue.push(frame(3)).expect("should have displaced one");
        assert_eq!(displaced.bytes, vec![1]);
        assert_eq!(queue.len(), 2);
    }

    #[tokio::test]
    async fn pop_returns_in_order_then_ends_when_closed() {
        let queue = Arc::new(FrameQueue::new(4));
        queue.push(frame(1));
        queue.push(frame(2));
        assert_eq!(queue.pop().await.unwrap().bytes, vec![1]);
        assert_eq!(queue.pop().await.unwrap().bytes, vec![2]);
        queue.close();
        assert!(queue.pop().await.is_none());
    }

    #[tokio::test]
    async fn a_waiting_reader_is_woken_by_a_push() {
        let queue = Arc::new(FrameQueue::new(4));
        let waiter = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.pop().await.map(|f| f.bytes) })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        queue.push(frame(9));
        assert_eq!(waiter.await.unwrap(), Some(vec![9]));
    }

    /// Closing must not strand frames that were already queued: a client that
    /// stops the stream should still receive what was captured.
    #[tokio::test]
    async fn closing_still_drains_what_is_queued() {
        let queue = Arc::new(FrameQueue::new(4));
        queue.push(frame(1));
        queue.close();
        assert_eq!(queue.pop().await.unwrap().bytes, vec![1]);
        assert!(queue.pop().await.is_none());
    }
}
