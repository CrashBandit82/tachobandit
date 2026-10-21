package main

// Driver card download via a PC/SC chip card reader (host pcscd socket mounted
// into the container). Follows the card download procedure of EU 2016/799
// Annex 1C Appendix 7: per EF select, hash, read, sign; the result is the
// usual TLV .ddd format (tag = FID + appendix 00/01 Gen1, 02/03 Gen2).
// The card is only read, never written (EF Card_Download stays unchanged).

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ebfe/scard"
	"github.com/traconiq/tachoparser/pkg/decoder"
)

type efSpec struct {
	fid uint16
	sig bool
}

var (
	aidTachoG1 = []byte{0xFF, 0x54, 0x41, 0x43, 0x48, 0x4F}
	aidTachoG2 = []byte{0xFF, 0x53, 0x4D, 0x52, 0x44, 0x54}
	efsMF      = []efSpec{{0x0002, false}, {0x0005, false}} // EF ICC, EF IC
	efsG1      = []efSpec{{0x0501, true}, {0xC100, false}, {0xC108, false}, {0x0520, true}, {0x050E, true},
		{0x0521, true}, {0x0502, true}, {0x0503, true}, {0x0504, true}, {0x0505, true}, {0x0506, true},
		{0x0507, true}, {0x0508, true}, {0x0522, true}}
	// Gen2 V2 files (0525…0540) are skipped when the card does not have them
	efsG2 = []efSpec{{0x0501, true}, {0xC100, false}, {0xC101, false}, {0xC108, false}, {0xC109, false},
		{0x0520, true}, {0x050E, true}, {0x0521, true}, {0x0502, true}, {0x0503, true}, {0x0504, true},
		{0x0505, true}, {0x0506, true}, {0x0507, true}, {0x0508, true}, {0x0522, true}, {0x0523, true},
		{0x0524, true}, {0x0525, true}, {0x0526, true}, {0x0527, true}, {0x0528, true}, {0x0529, true},
		{0x0530, true}, {0x0540, true}}
	errNotFound = errors.New("datei nicht vorhanden")
	readerMu    sync.Mutex
)

type swError uint16

func (e swError) Error() string { return fmt.Sprintf("Karte antwortet %04X", uint16(e)) }

// apdu sends a command and returns data + status word, handling the T=0 61xx/6Cxx responses.
func apdu(card *scard.Card, cmd []byte) ([]byte, uint16, error) {
	var out []byte
	for {
		resp, err := card.Transmit(cmd)
		if err != nil {
			return nil, 0, err
		}
		if len(resp) < 2 {
			return nil, 0, errors.New("kurze Antwort der Karte")
		}
		sw := binary.BigEndian.Uint16(resp[len(resp)-2:])
		out = append(out, resp[:len(resp)-2]...)
		switch sw >> 8 {
		case 0x61: // more data available
			cmd = []byte{0x00, 0xC0, 0x00, 0x00, byte(sw)}
		case 0x6C: // wrong Le, retry with the given one
			cmd = append(append([]byte{}, cmd[:len(cmd)-1]...), byte(sw))
		default:
			return out, sw, nil
		}
	}
}

func selectDF(card *scard.Card, aid []byte) error {
	_, sw, err := apdu(card, append([]byte{0x00, 0xA4, 0x04, 0x0C, byte(len(aid))}, aid...))
	if err == nil && sw != 0x9000 {
		err = swError(sw)
	}
	return err
}

func readBinary(card *scard.Card) ([]byte, error) {
	var data []byte
	le := 0xFF
	for len(data) < 0x8000 {
		off := len(data)
		chunk, sw, err := apdu(card, []byte{0x00, 0xB0, byte(off >> 8), byte(off), byte(le)})
		if err != nil {
			return nil, err
		}
		data = append(data, chunk...)
		switch {
		case sw == 0x9000 && len(chunk) > 0:
			continue
		case sw == 0x9000, sw == 0x6282, sw == 0x6B00: // end of file
			return data, nil
		case sw == 0x6700 && le > 1: // card refuses reading past the end: smaller steps
			le /= 2
		default:
			return nil, swError(sw)
		}
	}
	return data, nil
}

// readEF appends data (and signature) TLV records of one elementary file to buf.
func readEF(card *scard.Card, buf *bytes.Buffer, ef efSpec, gen2 bool) error {
	_, sw, err := apdu(card, []byte{0x00, 0xA4, 0x02, 0x0C, 0x02, byte(ef.fid >> 8), byte(ef.fid)})
	if err != nil {
		return err
	}
	if sw == 0x6A82 {
		return errNotFound
	}
	if sw != 0x9000 {
		return swError(sw)
	}
	if ef.sig { // PERFORM HASH OF FILE
		if _, sw, err = apdu(card, []byte{0x80, 0x2A, 0x90, 0x00}); err == nil && sw != 0x9000 {
			err = swError(sw)
		}
		if err != nil {
			return fmt.Errorf("Hash: %w", err)
		}
	}
	data, err := readBinary(card)
	if err != nil {
		return err
	}
	appendix := byte(0)
	if gen2 {
		appendix = 2
	}
	writeTLV(buf, ef.fid, appendix, data)
	if ef.sig {
		sig, err := sign(card, ef.fid, gen2)
		if err != nil {
			return fmt.Errorf("Signatur: %w", err)
		}
		writeTLV(buf, ef.fid, appendix+1, sig)
	}
	return nil
}

// Gen2 ECDSA signature length depends on the card's curve (64/96/128/132 bytes);
// cards refuse a wrong Le with 6700, so the working length is found once per read.
var gen2SigLens = []byte{0x40, 0x60, 0x80, 0x84}

// sign runs PSO: COMPUTE DIGITAL SIGNATURE over the hash of the file just read.
func sign(card *scard.Card, fid uint16, gen2 bool) ([]byte, error) {
	if !gen2 {
		return pso(card, 0x80) // Gen1 RSA-1024
	}
	for i, le := range gen2SigLens {
		if i > 0 { // the failed attempt may have consumed the hash: select + hash again
			if _, _, err := apdu(card, []byte{0x00, 0xA4, 0x02, 0x0C, 0x02, byte(fid >> 8), byte(fid)}); err != nil {
				return nil, err
			}
			if _, _, err := apdu(card, []byte{0x80, 0x2A, 0x90, 0x00}); err != nil {
				return nil, err
			}
		}
		sig, err := pso(card, le)
		if e, ok := err.(swError); ok && e == 0x6700 {
			continue
		}
		if err == nil && i > 0 { // try the working length first for the next files
			gen2SigLens[0], gen2SigLens[i] = gen2SigLens[i], gen2SigLens[0]
		}
		return sig, err
	}
	return nil, swError(0x6700)
}

func pso(card *scard.Card, le byte) ([]byte, error) {
	sig, sw, err := apdu(card, []byte{0x00, 0x2A, 0x9E, 0x9A, le})
	if err == nil && sw != 0x9000 {
		err = swError(sw)
	}
	return sig, err
}

func writeTLV(buf *bytes.Buffer, fid uint16, appendix byte, data []byte) {
	buf.Write([]byte{byte(fid >> 8), byte(fid), appendix, byte(len(data) >> 8), byte(len(data))})
	buf.Write(data)
}

func readCard() ([]byte, error) {
	ctx, err := scard.EstablishContext()
	if err != nil {
		return nil, fmt.Errorf("Kartenleser-Dienst (pcscd) nicht erreichbar: %w", err)
	}
	defer ctx.Release()
	readers, err := ctx.ListReaders()
	if err != nil || len(readers) == 0 {
		return nil, errors.New("kein Kartenleser gefunden")
	}
	states := make([]scard.ReaderState, len(readers))
	for i, r := range readers {
		states[i] = scard.ReaderState{Reader: r, CurrentState: scard.StateUnaware}
	}
	if err := ctx.GetStatusChange(states, 0); err != nil {
		return nil, fmt.Errorf("Kartenleser-Status: %w", err)
	}
	var card *scard.Card
	err = errors.New("keine Karte im Leser")
	for _, st := range states {
		if st.EventState&scard.StatePresent == 0 {
			continue
		}
		if st.EventState&scard.StateMute != 0 {
			err = errors.New("Karte reagiert nicht – richtig herum eingesteckt (Chip nach oben, voraus)?")
			continue
		}
		if card, err = ctx.Connect(st.Reader, scard.ShareExclusive, scard.ProtocolAny); err == nil {
			break
		}
		err = fmt.Errorf("Karte nicht ansprechbar: %w", err)
	}
	if card == nil {
		return nil, err
	}
	defer card.Disconnect(scard.ResetCard)

	var buf bytes.Buffer
	for _, ef := range efsMF { // MF is selected after reset
		if err := readEF(card, &buf, ef, false); err != nil {
			return nil, fmt.Errorf("EF %04X: %w", ef.fid, err)
		}
	}
	if err := selectDF(card, aidTachoG1); err != nil {
		return nil, fmt.Errorf("keine Fahrerkarte (Tachograph-Anwendung fehlt): %w", err)
	}
	for _, ef := range efsG1 {
		if err := readEF(card, &buf, ef, false); err != nil && err != errNotFound {
			return nil, fmt.Errorf("EF %04X: %w", ef.fid, err)
		}
	}
	if selectDF(card, aidTachoG2) == nil { // second generation card
		for _, ef := range efsG2 {
			if err := readEF(card, &buf, ef, true); err != nil && err != errNotFound {
				return nil, fmt.Errorf("Gen2 EF %04X: %w", ef.fid, err)
			}
		}
	}
	return buf.Bytes(), nil
}

func readCardHandler(w http.ResponseWriter, r *http.Request) {
	if !readerMu.TryLock() {
		fail(w, 409, "Karte wird bereits ausgelesen")
		return
	}
	defer readerMu.Unlock()
	start := time.Now()
	data, err := readCard()
	if err != nil {
		log.Printf("Karte auslesen: %v", err)
		fail(w, 502, err.Error())
		return
	}
	parsed, err := decode(data)
	if err != nil {
		fail(w, 422, "Kartendaten nicht lesbar: "+err.Error())
		return
	}
	c := parsed.(decoder.Card)
	no := strings.Trim(string(c.CardIdentificationAndDriverCardHolderIdentificationFirstGen.CardIdentification.CardNumber[:]), " \x00")
	if no == "" {
		no = strings.Trim(string(c.CardIdentificationAndDriverCardHolderIdentificationSecondGen.CardIdentification.CardNumber[:]), " \x00")
	}
	f, err := store(fmt.Sprintf("C_%s_%s.ddd", time.Now().UTC().Format("20060102_1504"), no), data)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	log.Printf("Karte %s ausgelesen: %d Bytes in %s", no, len(data), time.Since(start).Round(time.Millisecond))
	writeJSON(w, 200, f)
}
