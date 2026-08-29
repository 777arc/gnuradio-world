// Add a payload-length field to PDU metadata. This is deliberately a
// message-only shipped block: it exercises the synchronous PMT/message surface
// that distinguishes a JavaScript Block from the Embedded Python Block.
gr.export({
  label: 'PDU Length Metadata',
  doc: 'Adds js_payload_len to a PDU metadata dictionary.',

  init() {
    this.message_port_register_in(pmt.intern('in'));
    this.set_msg_handler(pmt.intern('in'), this.handle_pdu);
    this.message_port_register_out(pmt.intern('out'));
  },

  handle_pdu(msg) {
    if (!pmt.is_pair(msg)) {
      this.log('PDU Length Metadata expected a (metadata, payload) pair');
      return;
    }
    const payload = pmt.cdr(msg);
    const length = ArrayBuffer.isView(payload) ? payload.length : 0;
    const metadata = pmt.is_dict(pmt.car(msg)) ? pmt.car(msg) : pmt.make_dict();
    const updated = pmt.dict_add(
      metadata, pmt.intern('js_payload_len'), pmt.from_long(length));
    this.message_port_pub(pmt.intern('out'), pmt.cons(updated, payload));
  },
});
