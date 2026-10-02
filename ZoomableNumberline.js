/*!
 * ZoomableNumberline
 * An infinitely zoomable number line rendered on canvas.
 *
 * Minus/plus numbers are drawn red/blue and the line is split at zero with a
 * fading "pipe" gradient. Deep zoom is powered by an arbitrary-precision
 * decimal type (Num) so tick labels stay exact long after IEEE-754 would
 * have collapsed into float noise.
 *
 * Originally a prototype by pratikh; modernized and bug-fixed.
 * MIT licensed - see LICENSE.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function repeatStr(chr, count) {
    return count > 0 ? chr.repeat(count) : "";
  }

  /** Normalize "#rgb" / "#rrggbb" / "rgb()" into an "r,g,b" triple string. */
  function toRgbTriple(color) {
    if (typeof color !== "string") return "0,0,0";

    var hex = color.trim();

    if (hex.charAt(0) === "#") {
      hex = hex.slice(1);

      if (hex.length === 3) {
        hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
      }

      var r = parseInt(hex.substring(0, 2), 16);
      var g = parseInt(hex.substring(2, 4), 16);
      var b = parseInt(hex.substring(4, 6), 16);

      if (isNaN(r) || isNaN(g) || isNaN(b)) return "0,0,0";
      return r + "," + g + "," + b;
    }

    var match = hex.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);

    if (match) return match[1] + "," + match[2] + "," + match[3];

    return "0,0,0";
  }

  /* ------------------------------------------------------------------ *
   * Num - arbitrary precision decimal
   *
   * Representation: `digits` is an unsigned decimal string (no sign, no
   * point) and `dec` is how many of those digits sit after the decimal
   * point. Magnitude is therefore digits * 10^-dec, and `sign` carries
   * the sign. `dec` may be negative for trailing-zero integers.
   * ------------------------------------------------------------------ */

  function Num(s, base) {
    this.sign = 1;
    this.digits = "0";
    this.dec = 0;
    this.MAXDEC = 20;
    this.baseDigits = "0123456789ABCDEFGHJKLMNP";
    this.setNum(typeof s === "undefined" ? "0" : s, typeof base === "undefined" ? 10 : base);
  }

  Num.prototype.setNum = function (s, base) {
    base = typeof base === "undefined" ? 10 : base;

    if (s === null || typeof s === "undefined") {
      this.sign = 1;
      this.digits = "0";
      this.dec = 0;
      return this;
    }

    // Fast path for the integer zero (also covers "" and "0").
    if (s === 0 || s === "" || s === "0") {
      this.sign = 1;
      this.digits = "0";
      this.dec = 0;
      return this;
    }

    if (base !== 10) return this.setFromBase(String(s), base);

    var digits = String(s);
    this.sign = 1;

    if (digits.charAt(0) === "-") {
      this.sign = -1;
      digits = digits.substring(1);
    } else if (digits.charAt(0) === "+") {
      digits = digits.substring(1);
    }

    // Scientific notation: fold the exponent into `dec`.
    var eVal = 0;
    var ePos = digits.search(/[eE]/);

    if (ePos >= 0) {
      eVal = parseInt(digits.substring(ePos + 1), 10);
      if (isNaN(eVal)) eVal = 0;
      digits = digits.substring(0, ePos);
    }

    // Guard against Infinity / NaN strings reaching the digit parser.
    if (/[^0-9.]/.test(digits)) digits = digits.replace(/[^0-9.]/g, "");

    var dotPos = digits.indexOf(".");
    this.dec = dotPos < 0 ? 0 : digits.length - dotPos - 1;
    this.dec -= eVal;

    digits = digits.split(".").join("").replace(/^0+/, "");

    if (digits.length === 0) {
      this.sign = 1;
      this.digits = "0";
      this.dec = 0;
      return this;
    }

    this.digits = digits;
    return this;
  };

  Num.prototype.setFromBase = function (numStr, base) {
    var srcSign = "";
    numStr = String(numStr);

    if (numStr.charAt(0) === "-") {
      srcSign = "-";
      numStr = numStr.substring(1);
    }

    var dotPos = numStr.indexOf(".");
    var baseDec = dotPos < 0 ? 0 : numStr.length - dotPos - 1;
    numStr = numStr.split(".").join("").replace(/^0+/, "");

    if (numStr.length === 0) {
      this.setNum("0");
      return this;
    }

    var baseStr = base.toString();
    var result = this.baseDigits.indexOf(numStr.charAt(0).toUpperCase()).toString();

    for (var i = 1; i < numStr.length; i++) {
      var digit = this.baseDigits.indexOf(numStr.charAt(i).toUpperCase()).toString();
      result = this.fullMultiply(result, baseStr);
      result = this.fullAdd(result, digit);
    }

    if (baseDec > 0) {
      result = this.fullDivide(result, this.fullPower(baseStr, baseDec), this.MAXDEC);
    }

    this.setNum(srcSign + result);
    return this;
  };

  Num.prototype.clone = function () {
    var ansNum = new Num();
    ansNum.digits = this.digits;
    ansNum.dec = this.dec;
    ansNum.sign = this.sign;
    return ansNum;
  };

  /** Normalize "-0" to "0" so comparisons and formatting stay consistent. */
  Num.prototype.normalize = function () {
    if (this.digits === "0") this.sign = 1;
    return this;
  };

  Num.prototype.abs = function () {
    var ansNum = this.clone();
    ansNum.sign = 1;
    return ansNum;
  };

  /**
   * BUGFIX: the original kept `digits` as a raw string that could grow to
   * thousands of characters while zooming, which eventually froze the tab.
   * Dropping least-significant digits keeps the label visually identical
   * while bounding the cost of every later operation.
   *
   * The truncated digits are subtracted from `dec` as-is. Trailing zeros are
   * NOT stripped here: when the cut lands on a zero, stripping it would
   * silently shrink the value (1.1 -> 0.0011 style corruption).
   */
  Num.prototype.trimDigits = function (trimToLen) {
    if (this.digits.length > trimToLen && trimToLen > 0) {
      this.dec -= this.digits.length - trimToLen;
      this.digits = this.digits.substr(0, trimToLen);
      this.normalize();
    }

    return this;
  };

  /* ---------------------- digit-string primitives -------------------- */

  Num.prototype.compareDigits = function (x, y) {
    x = x.replace(/^0+/, "") || "0";
    y = y.replace(/^0+/, "") || "0";

    if (x.length > y.length) return 1;
    if (x.length < y.length) return -1;
    if (x === y) return 0;
    return x > y ? 1 : -1;
  };

  Num.prototype.fullAdd = function (x, y) {
    return this.addNums(new Num(x), new Num(y)).fmt();
  };

  Num.prototype.fullSubtract = function (x, y) {
    // BUGFIX: original computed the borrow flag without propagating a
    // pending borrow when the leading digit itself was borrowed from,
    // producing digits >9 for some inputs.
    var xNum = new Num(x);
    var yNum = new Num(y);

    if (this.compareDigits(xNum.digits, yNum.digits) < 0) {
      return "-" + this.fullSubtract(y, x);
    }

    var a = xNum.digits.split("").reverse();
    var b = yNum.digits.split("").reverse();
    var out = [];
    var borrow = 0;

    for (var i = 0; i < a.length; i++) {
      var av = (a[i] ? a[i].charCodeAt(0) - 48 : 0) - borrow;
      var bv = i < b.length ? b[i].charCodeAt(0) - 48 : 0;

      if (av < bv) {
        av += 10;
        borrow = 1;
      } else {
        borrow = 0;
      }

      out.push(av - bv);
    }

    return out.reverse().join("").replace(/^0+/, "") || "0";
  };

  Num.prototype.fullMultiply1 = function (x, y1) {
    var yDigit = y1.charCodeAt(0) - 48;
    var carry = 0;
    var ans = "";

    for (var i = x.length - 1; i >= 0; i--) {
      var product = (x.charCodeAt(i) - 48) * yDigit + carry;
      ans = (product % 10) + ans;
      carry = (product / 10) | 0;
    }

    if (carry > 0) ans = carry + ans;
    return ans.replace(/^0+/, "") || "0";
  };

  /** Karatsuba above 9 digits, schoolbook below (as in the original). */
  Num.prototype.fullMultiplyInt = function (x, y) {
    x = x.replace(/^0+/, "") || "0";
    y = y.replace(/^0+/, "") || "0";

    if (x === "0" || y === "0") return "0";
    if (x.length + y.length <= 9) return (parseInt(x, 10) * parseInt(y, 10)).toString();

    var xLen = x.length;
    var yLen = y.length;

    if (xLen < yLen) {
      var swap = x;
      x = y;
      y = swap;
      var tLen = xLen;
      xLen = yLen;
      yLen = tLen;
    }

    var split = Math.ceil(Math.max(xLen, yLen) / 2);
    var xSplit = Math.max(0, xLen - split);
    var x0 = x.substr(xSplit);
    var x1 = x.substring(0, xSplit);
    var ySplit = Math.max(0, yLen - split);

    if (ySplit <= 0 || xSplit <= 0) {
      var low = this.fullMultiplyInt(x0, y);
      var high = this.fullMultiplyInt(x1, y);
      return this.fullAdd(high + repeatStr("0", split), low);
    }

    var y0 = y.substr(ySplit);
    var y1 = y.substring(0, ySplit);
    var z0 = this.fullMultiplyInt(x1, y1);
    var z2 = this.fullMultiplyInt(x0, y0);
    var z1 = this.fullMultiplyInt(this.fullAdd(x1, x0), this.fullAdd(y1, y0));

    z1 = this.fullSubtract(z1, z2);
    z1 = this.fullSubtract(z1, z0);

    return this.fullAdd(this.fullAdd(z0 + repeatStr("0", split * 2), z1 + repeatStr("0", split)), z2);
  };

  Num.prototype.fullMultiply = function (x, y) {
    return this.fullMultiplyInt(new Num(x).digits, new Num(y).digits);
  };

  Num.prototype.fullPower = function (x, n) {
    return this.expNums(new Num(x), n).fmt();
  };

  Num.prototype.expNums = function (xNum, nInt) {
    var ansNum = new Num("1");
    var baseNum = xNum.clone();
    var n = nInt;

    while (n > 0) {
      if (n & 1) ansNum = ansNum.mult(baseNum);
      n >>= 1;
      if (n > 0) baseNum = baseNum.mult(baseNum);
    }

    return ansNum;
  };

  /**
   * Long division producing `decimals` places after the point.
   * BUGFIX: the original loop could spin without shrinking the dividend
   * whenever an intermediate remainder repeated, hanging the tab. The
   * iteration cap is now a hard guarantee rather than a soft one, and the
   * estimate never rounds up past the true quotient digit.
   */
  Num.prototype.divNums = function (xNum, yNum, decimals) {
    decimals = typeof decimals === "undefined" ? this.MAXDEC : decimals;

    if (xNum.isZero() || yNum.isZero()) return new Num("0");

    var sign = xNum.sign * yNum.sign;
    var xDigits = xNum.digits;
    var yDigits = yNum.digits;

    // Scale the dividend so the quotient lands with `decimals` places.
    var shift = decimals + yNum.dec - xNum.dec;

    if (shift > 0) {
      xDigits += repeatStr("0", shift);
    } else if (shift < 0) {
      yDigits += repeatStr("0", -shift);
    }

    xDigits = xDigits.replace(/^0+/, "") || "0";
    yDigits = yDigits.replace(/^0+/, "") || "0";

    if (this.compareDigits(xDigits, yDigits) < 0) return new Num("0");

    // Precompute the 1..9 multiplication table for the divisor.
    var table = [yDigits];
    for (var k = 2; k <= 9; k++) table.push(this.fullAdd(table[k - 2], yDigits));

    var quotient = "";
    var remainder = "";

    for (var i = 0; i < xDigits.length; i++) {
      remainder = (remainder + xDigits.charAt(i)).replace(/^0+/, "");

      var digit = 0;

      if (this.compareDigits(remainder, yDigits) >= 0) {
        digit = 9;
        while (digit > 1 && this.compareDigits(table[digit - 1], remainder) > 0) digit--;
        remainder = this.fullSubtract(remainder, table[digit - 1]);
      }

      quotient += digit;
    }

    quotient = quotient.replace(/^0+/, "") || "0";

    // Round-half-up on the first dropped digit so 2/3 reads 0.667 rather
    // than 0.666 at low precision. The remainder is exactly what was left
    // undivided, so comparing twice it against the divisor is exact.
    var roundUp = this.compareDigits(this.fullAdd(remainder, remainder), yDigits) >= 0;

    if (roundUp) quotient = this.fullAdd(quotient, "1");

    var ansNum = new Num(quotient);
    ansNum.dec = decimals;
    ansNum.sign = sign;
    return ansNum.normalize();
  };

  /* --------------------------- arithmetic ---------------------------- */

  Num.prototype.mult10 = function (n) {
    var xNew = this.clone();
    xNew.dec -= n;

    if (xNew.dec < 0) {
      xNew.digits += repeatStr("0", -xNew.dec);
      xNew.dec = 0;
    }

    return xNew;
  };

  Num.prototype.mult = function (num) {
    return this.multNums(this, num);
  };

  Num.prototype.multNums = function (xNum, yNum) {
    if (xNum.isZero() || yNum.isZero()) return new Num("0");

    var ansNum = new Num(this.fullMultiplyInt(xNum.digits, yNum.digits));
    ansNum.dec = xNum.dec + yNum.dec;
    ansNum.sign = xNum.sign * yNum.sign;
    return ansNum.normalize();
  };

  Num.prototype.add = function (num) {
    return this.addNums(this, num);
  };

  Num.prototype.addNums = function (xNum, yNum) {
    if (xNum.isZero()) return yNum.clone();
    if (yNum.isZero()) return xNum.clone();

    if (xNum.sign !== yNum.sign) {
      var ansNum = this.subNums(xNum.abs(), yNum.abs());
      ansNum.sign = xNum.abs().compare(yNum.abs()) >= 0 ? xNum.sign : yNum.sign;
      return ansNum.normalize();
    }

    var maxdec = Math.max(xNum.dec, yNum.dec);
    var xdig = xNum.digits + repeatStr("0", maxdec - xNum.dec);
    var ydig = yNum.digits + repeatStr("0", maxdec - yNum.dec);
    var maxlen = Math.max(xdig.length, ydig.length);

    xdig = repeatStr("0", maxlen - xdig.length) + xdig;
    ydig = repeatStr("0", maxlen - ydig.length) + ydig;

    var ans = "";
    var carry = 0;

    for (var i = xdig.length - 1; i >= 0; i--) {
      var temp = xdig.charCodeAt(i) - 48 + (ydig.charCodeAt(i) - 48) + carry;
      ans = (temp % 10) + ans;
      carry = temp >= 10 ? 1 : 0;
    }

    if (carry === 1) ans = "1" + ans;

    var sumNum = new Num(ans);
    sumNum.sign = xNum.sign;
    sumNum.dec = maxdec;
    return sumNum.normalize();
  };

  Num.prototype.sub = function (num) {
    return this.subNums(this, num);
  };

  Num.prototype.subNums = function (xNum, yNum) {
    if (yNum.isZero()) return xNum.clone();

    if (xNum.sign !== yNum.sign) {
      var sumNum = this.addNums(xNum.abs(), yNum.abs());
      sumNum.sign = xNum.sign;
      return sumNum.normalize();
    }

    var maxdec = Math.max(xNum.dec, yNum.dec);
    var xdig = xNum.digits + repeatStr("0", maxdec - xNum.dec);
    var ydig = yNum.digits + repeatStr("0", maxdec - yNum.dec);
    var maxlen = Math.max(xdig.length, ydig.length);

    xdig = repeatStr("0", maxlen - xdig.length) + xdig;
    ydig = repeatStr("0", maxlen - ydig.length) + ydig;

    var sign = this.compareDigits(xdig, ydig);

    if (sign === 0) return new Num("0");

    if (sign < 0) {
      var swap = xdig;
      xdig = ydig;
      ydig = swap;
    }

    var ansNum = new Num(this.fullSubtract(xdig, ydig));
    ansNum.sign = sign * xNum.sign;
    ansNum.dec = maxdec;
    return ansNum.normalize();
  };

  Num.prototype.div = function (num, decimals) {
    return this.divNums(this, num, decimals);
  };

  Num.prototype.fullDivide = function (x, y, decimals) {
    return this.divNums(new Num(x), new Num(y), decimals).fmt();
  };

  Num.prototype.compare = function (yNum) {
    return this.compareNums(this, yNum);
  };

  Num.prototype.compareNums = function (xNum, yNum) {
    if (xNum.isZero()) xNum = new Num("0");
    if (yNum.isZero()) yNum = new Num("0");

    if (xNum.sign > yNum.sign) return 1;
    if (xNum.sign < yNum.sign) return -1;

    var maxdec = Math.max(xNum.dec, yNum.dec);
    var xdig = xNum.digits + repeatStr("0", maxdec - xNum.dec);
    var ydig = yNum.digits + repeatStr("0", maxdec - yNum.dec);
    var maxlen = Math.max(xdig.length, ydig.length);

    xdig = repeatStr("0", maxlen - xdig.length) + xdig;
    ydig = repeatStr("0", maxlen - ydig.length) + ydig;

    if (xdig === ydig) return 0;
    return (xdig > ydig ? 1 : -1) * xNum.sign;
  };

  Num.prototype.isZero = function () {
    return this.digits === "0" || this.digits === "";
  };

  /**
   * Best-effort double: correctly rounded for any decimal string.
   *
   * The whole significand is emitted in scientific notation and parsed in a
   * single `Number()` call. Doing the conversion in one step matters —
   * taking a 17-digit window and then scaling by a power of ten rounds
   * twice and can land one ULP off (e.g. -0.9999999999999273 instead of
   * -0.9999999999999274).
   */
  Num.prototype.getNumber = function () {
    if (this.isZero()) return 0;

    // Exponent of the leading digit, so "123.45" -> "1.2345e+2".
    var exp = this.digits.length - this.dec - 1;
    var mantissa = this.digits.charAt(0);

    if (this.digits.length > 1) {
      mantissa += "." + this.digits.substring(1);
    }

    var value = Number(mantissa + "e" + exp);

    return this.sign === -1 ? -value : value;
  };

  /**
   * Decimal string.
   *
   * `sigDigits` requests a minimum number of significant digits: shorter
   * values are padded with trailing zeros. Padding extends the fractional
   * part, so `dec` must grow by exactly the number of zeros added —
   * otherwise the value silently scales up by a power of ten.
   *
   * `eStt` switches to exponent form once |exponent| >= eStt.
   */
  Num.prototype.fmt = function (sigDigits, eStt) {
    sigDigits = typeof sigDigits === "undefined" ? 0 : sigDigits;
    eStt = typeof eStt === "undefined" ? 0 : eStt;

    if (this.isZero()) return "0";

    var s = this.digits;
    var dec = this.dec;

    if (s.length < sigDigits) {
      // BUGFIX: the original padded `digits` without adjusting `dec`, so
      // fmt(20) on 0.0133... returned 13333333.333. getNumber() relies on
      // this, which made every pixel mapping wrong by orders of magnitude.
      var pad = sigDigits - s.length;
      s += repeatStr("0", pad);
      dec += pad;
    }

    var decpos = s.length - dec;

    if (eStt > 0) {
      var eVal = decpos - 1;

      if (Math.abs(eVal) >= eStt) {
        var mantissa = s.charAt(0) + "." + s.substring(1);
        mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
        s = mantissa + "e" + (eVal > 0 ? "+" : "") + eVal;
        return this.sign === -1 ? "-" + s : s;
      }
    }

    if (decpos <= 0) {
      s = "0." + repeatStr("0", -decpos) + s;
    } else if (decpos < s.length) {
      s = s.substring(0, decpos) + "." + s.substring(decpos);
    } else if (decpos > s.length) {
      // BUGFIX: a negative `dec` (integer with implied trailing zeros, e.g.
      // the result of mult10) had no branch here, so "1e3" formatted as "1".
      s = s + repeatStr("0", decpos - s.length);
    }

    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");

    return this.sign === -1 ? "-" + s : s;
  };

  Num.prototype.getSci = function () {
    if (this.isZero()) return ["0", 0];

    var s = this.digits.charAt(0) + "." + this.digits.substring(1);
    s = s.replace(/0+$/, "").replace(/\.$/, "");

    return [s, this.digits.length - this.dec - 1];
  };

  /* ------------------------------------------------------------------ *
   * Coords - the visible numeric window, with a pixel mapping
   * ------------------------------------------------------------------ */

  function Coords(width, height, xStt, yStt, xEnd, yEnd) {
    this.maxDigits = 40;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.xStt = new Num(xStt);
    this.yStt = new Num(yStt);
    this.xEnd = new Num(xEnd);
    this.yEnd = new Num(yEnd);
    this.xScale = new Num("1");
    this.calcScale();
  }

  Coords.prototype.calcScale = function () {
    if (this.xStt.compare(this.xEnd) > 0) {
      var temp = this.xStt;
      this.xStt = this.xEnd;
      this.xEnd = temp;
    }

    var xSpan = this.xEnd.sub(this.xStt);

    if (xSpan.compare(new Num("0")) <= 0) xSpan = new Num("1");

    this.xSpan = xSpan;
    this.xScale = xSpan.div(new Num(this.width.toString()), 12);
  };

  Coords.prototype.trimDigits = function () {
    this.xStt.trimDigits(this.maxDigits);
    this.xEnd.trimDigits(this.maxDigits);
    this.yStt.trimDigits(this.maxDigits);
    this.yEnd.trimDigits(this.maxDigits);
  };

  Coords.prototype.rel2Num = function (rel) {
    return this.xStt.add(this.xSpan.mult(new Num(rel.toString())));
  };

  Coords.prototype.num2Rel = function (num) {
    // Kept in floating point: only used for screen placement, where
    // double precision is far more than enough.
    var span = this.xEnd.sub(this.xStt).getNumber();
    if (!span) return 0.5;
    return (num.getNumber() - this.xStt.getNumber()) / span;
  };

  /** BUGFIX: `rangeNum` was used before it was ever assigned. */
  Coords.prototype.scale = function (factor, mid) {
    var delta = new Num((factor - 1).toString());
    var rangeNum = this.xSpan;

    this.xStt = this.xStt.add(rangeNum.mult(delta).mult(new Num((0 - mid).toString())));
    this.xEnd = this.xEnd.add(rangeNum.mult(delta).mult(new Num((1 - mid).toString())));
    this.trimDigits();
    this.calcScale();
  };

  Coords.prototype.moveRel = function (val) {
    var moveNum = this.xSpan.mult(new Num(val.toString()));
    this.xStt = this.xStt.add(moveNum);
    this.xEnd = this.xEnd.add(moveNum);
    this.trimDigits();
    this.calcScale();
  };

  Coords.prototype.toXNum = function (pix) {
    return this.xStt.add(this.xScale.mult(new Num(pix.toString())));
  };

  Coords.prototype.toXVal = function (pix) {
    return this.toXNum(pix).getNumber();
  };

  /**
   * Choose a "nice" tick step (1, 2 or 5 x 10^k) at or just above `span`.
   *
   * `span` is the desired spacing expressed in data units, so the result is
   * the smallest nice number that keeps ticks from crowding.
   *
   * BUGFIX: the original walked a table in ascending order and matched the
   * first row whose limit the mantissa exceeded, which the `limit: 0` row
   * always satisfied. Every zoom level produced a major step of exactly 10,
   * so the line rendered with two labels no matter the range.
   *
   * The mantissa here is in [1, 10); the candidate steps are
   * {1, 2, 5} x 10^exponent, and the smallest candidate >= span wins.
   *
   * `majorQ` selects the major step. The minor step always subdivides the
   * major into a whole number of intervals (2 -> 0.5, 5 -> 1, 1 -> 0.2).
   */
  Coords.prototype.tickInterval = function (span, majorQ) {
    var sci = span.abs().getSci();
    var mantissa = Number(sci[0]);
    var exponent = sci[1];

    if (!isFinite(mantissa) || mantissa <= 0) {
      mantissa = 1;
      exponent = 0;
    }

    // Normalise into [1, 10) in case of any rounding drift from getSci.
    while (mantissa >= 10) {
      mantissa /= 10;
      exponent += 1;
    }

    // The mantissa is already normalised, so the candidates at this decade
    // are simply 1, 2 and 5; the first one >= mantissa is the answer.
    var nice;

    if (mantissa <= 1) nice = 1;
    else if (mantissa <= 2) nice = 2;
    else if (mantissa <= 5) nice = 5;
    else nice = 10; // rounds up into the next decade

    var step = new Num(nice.toString()).mult10(exponent);

    // nice === 10 means "1 x 10^(exponent+1)"; mult10 already handled the
    // magnitude, so no further exponent adjustment is needed.
    if (majorQ) return step;

    // Minor ticks subdivide the major interval into a whole number of
    // steps, snapped to the 1/2/5 family so labels stay readable.
    var minorFactor;

    if (nice === 10) minorFactor = new Num("2").mult10(exponent);
    else if (nice === 5) minorFactor = new Num("1").mult10(exponent);
    else if (nice === 2) minorFactor = new Num("5").mult10(exponent - 1);
    else minorFactor = new Num("2").mult10(exponent - 1);

    return minorFactor;
  };

  Coords.prototype.xTickInterval = function (sparseness, majorQ) {
    return this.tickInterval(this.xSpan.mult(new Num(sparseness.toString())), majorQ);
  };

  /* ------------------------------------------------------------------ *
   * Canvas extensions
   * ------------------------------------------------------------------ */

  CanvasRenderingContext2D.prototype.drawArrow = function (
    x0, y0, totLen, shaftHt, headLen, headHt, angle, sweep, invertQ
  ) {
    // BUGFIX: the original shadowed the module-level context with
    // `var g = this`, which broke the moment the global was renamed.
    var ctx = this;
    var pts = [
      [0, 0],
      [-headLen, -headHt / 2],
      [-headLen + sweep, -shaftHt / 2],
      [-totLen, -shaftHt / 2],
      [-totLen, shaftHt / 2],
      [-headLen + sweep, shaftHt / 2],
      [-headLen, headHt / 2],
      [0, 0]
    ];

    if (invertQ) {
      pts.push(
        [0, -headHt / 2],
        [-totLen, -headHt / 2],
        [-totLen, headHt / 2],
        [0, headHt / 2]
      );
    }

    var cosa = Math.cos(-angle);
    var sina = Math.sin(-angle);

    for (var i = 0; i < pts.length; i++) {
      var xPos = pts[i][0] * cosa + pts[i][1] * sina;
      var yPos = pts[i][0] * sina - pts[i][1] * cosa;

      if (i === 0) ctx.moveTo(x0 + xPos, y0 + yPos);
      else ctx.lineTo(x0 + xPos, y0 + yPos);
    }
  };

  CanvasRenderingContext2D.prototype.drawPipe = function (x0, y0, x1, y1, clr) {
    var ctx = this;
    var alphas = [0.8, 0.4, 0.3, 0.2, 0.4, 0.6, 0.8];
    var size = alphas.length;
    var rgb = toRgbTriple(clr);

    ctx.save();
    ctx.lineCap = "round";

    for (var i = 0; i < size; i++) {
      var dist = (size / 2 - 0.5 - i) * 0.8;

      ctx.beginPath();

      if (y0 === y1) {
        ctx.moveTo(x0, y0 - dist);
        ctx.lineTo(x1, y1 - dist);
      } else {
        ctx.moveTo(x0 + dist, y0);
        ctx.lineTo(x1 + dist, y1);
      }

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();

      ctx.strokeStyle = "rgba(" + rgb + "," + alphas[i] + ")";
      ctx.stroke();
    }

    ctx.restore();
  };

  /* ------------------------------------------------------------------ *
   * Renderer / interaction controller
   * ------------------------------------------------------------------ */

  var THEME = {
    bg: "#eef6ff",
    negative: "#e5484d",
    positive: "#0b6bcb",
    zero: "#111827",
    tick: "#9aa8bd"
  };

  var DEFAULTS = {
    width: 1000,
    minHeight: 150,
    left: 40,
    lineWidth: 900,
    lineY: 70,
    zoomStep: 1.02,
    edge: 60,
    edgeSpeed: 0.0006,
    maxDigits: 40,
    maxTicks: 400
  };

  function Numberline(canvas, options) {
    options = options || {};

    this.canvas = typeof canvas === "string" ? document.querySelector(canvas) : canvas;

    if (!this.canvas) throw new Error("ZoomableNumberline: canvas not found");

    this.opt = Object.assign({}, DEFAULTS, options);
    this.ctx = this.canvas.getContext("2d");

    // State
    this.zoomInQ = true;
    this.marksQ = true;
    this.marks = [{ num: new Num("3.14159"), label: "π" }];
    this.zoomCount = 0;
    this.moveCount = 0;
    this.pointerDown = false;
    this.currX = this.opt.width / 2;
    this.zoomLevel = 0;
    this.hoverX = null;
    this.destroyed = false;

    this.coords = new Coords(
      this.opt.lineWidth, this.opt.minHeight, "-1", "-10", "11", "10"
    );

    this._bindEvents();
    this.resize();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  Numberline.prototype.reset = function () {
    if (this.destroyed) return this;

    this.coords = new Coords(
      this.opt.lineWidth, this.opt.minHeight, "-1", "-10", "11", "10"
    );
    this.zoomLevel = 0;
    this.zoomCount = 0;
    this.moveCount = 0;
    this.redraw();
    this._emitChange();
    return this;
  };

  /** Keep the backing store in sync with CSS size and devicePixelRatio. */
  Numberline.prototype.resize = function () {
    if (this.destroyed) return;

    var rect = this.canvas.getBoundingClientRect();
    var cssW = rect.width || this.opt.width;
    var cssH = rect.height || this.opt.minHeight;

    // Cap DPR: past 3x the extra pixels cost more than they show.
    var dpr = Math.min(global.devicePixelRatio || 1, 3);

    this.opt.width = cssW;
    this.opt.minHeight = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    // The line occupies the canvas minus a margin on each side.
    this.opt.left = Math.max(16, Math.round(cssW * 0.04));
    this.opt.lineWidth = Math.round(cssW - this.opt.left * 2);

    // Content is stacked above the line: a marker band, then a label row,
    // then the ticks. Only a small amount sits below. Centring the line in
    // the canvas left a dead band at the bottom, so the line is placed so
    // the whole composition reads as balanced.
    var topBand = 78; // marker + label rows
    var bottomBand = 20;
    var usable = Math.max(60, cssH - topBand - bottomBand);

    this.opt.lineY = Math.round(topBand + usable * 0.72);

    this.dpr = dpr;
    this.scale = 1;

    this.coords.width = this.opt.lineWidth;
    this.coords.calcScale();

    if (this.currX === 0) this.currX = cssW / 2;
    this.currX = Math.min(Math.max(this.currX, 0), cssW);

    this.redraw();
  };

  Numberline.prototype._bindEvents = function () {
    var self = this;
    var el = this.canvas;

    function localX(clientX) {
      var rect = el.getBoundingClientRect();
      return rect.width ? ((clientX - rect.left) / rect.width) * self.opt.width : 0;
    }

    el.addEventListener("pointermove", function (ev) {
      if (self.destroyed) return;
      self.currX = localX(ev.clientX);
      self.hoverX = self.currX;
    });

    el.addEventListener("pointerdown", function (ev) {
      if (self.destroyed) return;
      self.pointerDown = true;
      self.shiftQ = ev.shiftKey;
      self.currX = localX(ev.clientX);

      // A canvas does not take focus from a pointer press on its own, so
      // the keyboard shortcuts would only ever work after a Tab. Focusing
      // here is what makes "click the line, then use the arrow keys" work.
      if (document.activeElement !== el) {
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      }

      // Keep receiving events if the pointer leaves the canvas mid-drag.
      if (el.setPointerCapture) {
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
      el.classList.add("is-active");
      ev.preventDefault();
    });

    function release(ev) {
      if (self.destroyed || !self.pointerDown) return;
      self.pointerDown = false;
      // Pending wheel/key notches are intentionally left alone: clearing
      // them here swallowed zoom the user had just requested.
      el.classList.remove("is-active");
      if (ev && el.releasePointerCapture && ev.pointerId != null) {
        try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
    }

    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    global.addEventListener("pointerup", release);

    el.addEventListener("pointerleave", function () {
      self.hoverX = null;
    });

    // BUGFIX: wheel, keyboard and double-click handlers were defined but
    // never attached in the original, so those inputs did nothing.
    var WHEEL_NOTCHES = 5;

    el.addEventListener(
      "wheel",
      function (ev) {
        if (self.destroyed) return;

        var delta = ev.deltaY || 0;

        // Normalise the three deltaMode units to something comparable.
        if (ev.deltaMode === 1) delta *= 16;
        else if (ev.deltaMode === 2) delta *= 400;

        self.currX = localX(ev.clientX);

        // One physical notch is ~100px of deltaY. Scrolling down (delta > 0)
        // means zoom OUT, so the sign is negated against zoomCount's
        // "positive = zoom in" convention.
        var notches = Math.round(Math.max(-3, Math.min(3, delta / 100)) * WHEEL_NOTCHES);

        if (notches === 0) notches = delta > 0 ? WHEEL_NOTCHES : -WHEEL_NOTCHES;

        // Clamp the queue so a fast flick cannot bank an unbounded amount of
        // zoom that keeps running long after the user has stopped.
        self.zoomCount = Math.max(-60, Math.min(60, self.zoomCount - notches));

        ev.preventDefault();
      },
      { passive: false }
    );

    el.addEventListener("dblclick", function (ev) {
      if (self.destroyed) return;
      self.currX = localX(ev.clientX);
      self.zoomCount = Math.max(-60, Math.min(60, self.zoomCount + (self.zoomInQ ? 30 : -30)));
      ev.preventDefault();
    });

    // One keydown listener on the element is enough: the canvas is focusable
    // and focus is taken on pointerdown. Registering a second listener on
    // window (as an earlier revision did) double-fired every shortcut.
    el.addEventListener("keydown", function (ev) {
      if (self.destroyed) return;
      self.onKey(ev);
    });

    el.tabIndex = 0;

    global.addEventListener("resize", function () {
      self.resize();
    });

    if (global.ResizeObserver) {
      new ResizeObserver(function () {
        self.resize();
      }).observe(el.parentElement || el);
    }
  };

  /** Keyboard control. Positive counts zoom in / pan right. */
  Numberline.prototype.onKey = function (ev) {
    if (this.destroyed) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    switch (ev.key) {
      case "ArrowUp":
      case "w":
      case "W":
      case "+":
      case "=":
        this.zoomCount += 8; // zoom in
        break;
      case "ArrowDown":
      case "s":
      case "S":
      case "-":
      case "_":
        this.zoomCount -= 8; // zoom out
        break;
      case "ArrowLeft":
      case "a":
      case "A":
        this.moveCount -= 8;
        break;
      case "ArrowRight":
      case "d":
      case "D":
        this.moveCount += 8;
        break;
      case "r":
      case "R":
        this.reset();
        break;
      default:
        return;
    }

    this.shiftQ = ev.shiftKey;
    ev.preventDefault();
  };

  Numberline.prototype.toggleZoomIn = function () {
    if (this.destroyed) return this.zoomInQ;

    this.zoomInQ = !this.zoomInQ;
    this._emitChange();
    return this.zoomInQ;
  };

  Numberline.prototype.setZoomIn = function (on) {
    if (this.destroyed) return this;

    this.zoomInQ = !!on;
    this._emitChange();
  };

  /**
   * Queue `steps` zoom steps. Positive zooms in, negative zooms out.
   * The queue is clamped so a runaway cannot be banked.
   */
  Numberline.prototype.zoomBy = function (steps) {
    if (this.destroyed) return this;

    this.zoomCount = Math.max(-60, Math.min(60, this.zoomCount + steps));
    return this;
  };

  /**
   * Human-readable window bounds. The span decides how many decimals are
   * worth showing, so a wide view stays short while a deep zoom stays
   * informative instead of always printing the full 40-digit window.
   */
  Numberline.prototype.getRangeLabel = function () {
    if (!this.coords) return "";

    var span = this.coords.xEnd.sub(this.coords.xStt);
    var sci = span.abs().getSci();
    var exp = sci[1];

    // Show ~3 decimals past the leading digit of the span, capped so the
    // HUD line cannot grow without bound.
    var places = Math.max(0, Math.min(24, 3 - exp));
    var sig = Math.max(8, places + 5);

    return this.coords.xStt.fmt(sig, 0) + " … " + this.coords.xEnd.fmt(sig, 0);
  };

  Numberline.prototype._emitChange = function () {
    if (this.destroyed) return;

    if (typeof this.opt.onChange === "function") {
      this.opt.onChange({
        zoomLevel: this.zoomLevel,
        zoomInQ: this.zoomInQ,
        range: this.getRangeLabel()
      });
    }
  };

  /**
   * One animation tick.
   *
   * Continuous input (a held pointer, a key held down) is expressed as a
   * per-frame *rate*; discrete input (a wheel notch, a double click) is an
   * accumulator of pending notches. Both drain through the same bounded
   * budget so a fast flick cannot dump hundreds of redraws into one frame.
   */
  Numberline.prototype._loop = function () {
    // A destroy() during the previous tick must win over the re-arm below.
    if (this.destroyed) return;

    var edge = this.opt.edge;
    var heldZoom = 0;
    var heldPan = 0;

    if (this.pointerDown) {
      if (this.currX < edge || this.currX > this.opt.width - edge) {
        // Pointer parked near an edge: pan continuously, faster the closer
        // it gets to the border.
        heldPan =
          this.currX < edge
            ? -(edge - this.currX) * this.opt.edgeSpeed
            : (this.currX - (this.opt.width - edge)) * this.opt.edgeSpeed;
      } else {
        // Pointer held over the line: zoom at a fixed rate per frame. This
        // is a *rate*, not an accumulator, so it is applied separately and
        // never added to the queued wheel/key notches.
        heldZoom = this.shiftQ || !this.zoomInQ ? -1 : 1;
      }
    }

    // Anything the user queued (wheel, double click, buttons, keys).
    // Positive zoomCount means zoom in, matching doZoom's convention.
    var pendingZoom = this.zoomCount;
    var pendingPan = this.moveCount;
    this.zoomCount = 0;
    this.moveCount = 0;

    // Zoom is geometric, so N steps collapse into one exact pow() rather
    // than N redraws. This is what keeps a fast wheel flick cheap.
    var zoomSteps = Math.max(-14, Math.min(14, pendingZoom));

    if (zoomSteps !== 0) {
      this.doZoom(zoomSteps);
    } else if (heldZoom !== 0) {
      // Only applies once the queue has drained, so held and queued zoom
      // never interleave into a runaway.
      this.doZoom(heldZoom);
    }

    if (pendingPan !== 0) {
      // Pan is linear, so one relative move is exact and far cheaper than
      // replaying N discrete steps.
      this.doMove(Math.max(-14, Math.min(14, pendingPan)));
    } else if (heldPan !== 0) {
      this.coords.moveRel(heldPan);
      this.redraw();
      this._emitChange();
    }

    this._raf = requestAnimationFrame(this._loop);
  };

  /**
   * Stop the animation loop. The instance becomes inert: further calls to
   * resize/reset/redraw are ignored rather than restarting the loop.
   */
  Numberline.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;

    this.pointerDown = false;
    this.zoomCount = 0;
    this.moveCount = 0;

    if (this.coords) this.coords = null;
  };

  /**
   * Apply one zoom step.
   *
   * Convention, used everywhere: a positive argument means ZOOM IN, which
   * shrinks the visible numeric window (scale factor < 1 makes the span
   * smaller). `zoomLevel` therefore counts steps of magnification, and
   * `zoomCount` accumulates the same sign.
   *
   * BUGFIX: the original mixed two conventions — `zoomCount` was positive
   * for zoom-in while `doZoom` treated positive as zoom-out, so the arrow
   * keys and the toolbar buttons did the opposite of their labels.
   */
  Numberline.prototype.doZoom = function (steps) {
    if (this.destroyed || !this.coords || !steps) return;

    var rel = (this.currX - this.opt.left) / this.opt.lineWidth;
    rel = Math.max(Math.min(rel, 1), 0);

    // Zooming in narrows the window by zoomStep per step.
    var factor = Math.pow(this.opt.zoomStep, -steps);

    this.coords.scale(factor, rel);
    this.zoomLevel += steps;
    this.redraw();
    this._emitChange();
  };

  /**
   * Pan by `steps` screen-widths. Positive moves toward positive numbers.
   */
  Numberline.prototype.doMove = function (steps) {
    if (this.destroyed || !this.coords || !steps) return;
    this.coords.moveRel(steps * 0.015);
    this.redraw();
    this._emitChange();
  };

  /**
   * BUGFIX: when zoomed far in, the visible window is much narrower than
   * the "sparseness" span, so the tick loop could try to emit tens of
   * thousands of ticks. The count is now hard-capped.
   */
  Numberline.prototype.getTicks = function () {
    if (this.destroyed || !this.coords) return [];

    var coords = this.coords;

    // Target: a major tick every ~7% of the visible span, rounded up to a
    // nice 1/2/5 step. That yields roughly a dozen labelled ticks.
    var sparseness = 0.07;
    var majorTick = coords.xTickInterval(sparseness, true);
    var minorTick = coords.xTickInterval(sparseness, false);

    if (majorTick.isZero() || minorTick.isZero()) return [];

    var perMajor = Math.round(majorTick.div(minorTick, 0).getNumber());

    if (!isFinite(perMajor) || perMajor < 1) perMajor = 1;
    if (perMajor > 100) perMajor = 100;

    var minorNum = majorTick.div(new Num(perMajor.toString()), 30);
    var curNum = coords.xStt.div(majorTick, 0).sub(new Num("1")).mult(majorTick);

    // Labels sit on major ticks, so the space that matters is the gap
    // BETWEEN MAJORS. Measuring against the minor gap suppressed almost
    // every label and left the line showing only "0" and "10".
    var majorGap = Math.abs(this.num2pix(majorTick) - this.num2pix(new Num("0")));
    var sampleLabel = majorTick.fmt(40, 0);
    var labelQ = majorGap > sampleLabel.length * 9 + 14;

    var ticks = [];
    var guard = 0;

    while (curNum.compare(coords.xEnd) <= 0 && ticks.length < this.opt.maxTicks && guard++ < 5000) {
      var tick = curNum.clone();

      for (var i = 0; i < perMajor; i++, tick = tick.add(minorNum)) {
        if (tick.compare(coords.xStt) < 0) continue;
        if (tick.compare(coords.xEnd) > 0) continue;

        ticks.push({
          major: i === 0,
          px: this.num2pix(tick),
          label: labelQ && i === 0 ? this.tickLabel(tick, majorTick) : null,
          isZero: tick.isZero()
        });

        if (ticks.length >= this.opt.maxTicks) break;
      }

      curNum = curNum.add(majorTick);
    }

    return ticks;
  };

  /** Shortest exact label for a tick, given the step between majors. */
  Numberline.prototype.tickLabel = function (num, step) {
    var s = num.fmt(40, 0);

    if (s.length > 14) {
      // Very long labels are useless on screen; fall back to exponent form.
      s = num.fmt(40, 7);
    }

    return s;
  };

  Numberline.prototype.num2pix = function (num) {
    var span = this.coords.xEnd.sub(this.coords.xStt).getNumber();
    if (!span) return 0;
    return ((num.getNumber() - this.coords.xStt.getNumber()) / span) * this.coords.width;
  };

  Numberline.prototype.redraw = function () {
    if (this.destroyed || !this.coords) return;

    var ctx = this.ctx;
    var dpr = this.dpr || 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.drawNumLine(ctx);
  };

  Numberline.prototype.drawNumLine = function (ctx) {
    var opt = this.opt;
    var coords = this.coords;
    var ticks = this.getTicks();
    var yLn = opt.lineY;
    var baseline = Math.round(yLn) + 0.5;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineCap = "round";

    var minV = Infinity;
    var maxV = -Infinity;
    var zeroPx = null;

    for (var i = 0; i < ticks.length; i++) {
      var tick = ticks[i];
      var xp = opt.left + tick.px;
      var label = tick.label;
      var numeric = label === null ? null : Number(label);

      if (numeric !== null) {
        if (numeric > maxV) maxV = numeric;
        if (numeric < minV) minV = numeric;
      }

      var color = THEME.tick;
      var height = tick.major ? 13 : 7;

      if (tick.isZero) {
        zeroPx = xp;
        color = THEME.zero;
        height = 16;
      } else if (numeric !== null && numeric < 0) {
        color = THEME.negative;
        height = tick.major ? 13 : 7;
      } else if (numeric !== null && numeric > 0) {
        color = THEME.positive;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = tick.major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(xp, baseline - height / 2);
      ctx.lineTo(xp, baseline + height / 2);
      ctx.stroke();

      if (tick.isZero) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(xp, baseline, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (label !== null) {
        ctx.font = tick.major ? "600 15px ui-sans-serif, system-ui, Arial" : "13px Arial";
        ctx.fillStyle = color;
        // Alternate label rows so dense majors do not collide.
        var row = tick.major && String(label).length > 5 && i % 2 ? 50 : 28;
        ctx.fillText(label, xp, baseline - row);
      }
    }

    ctx.restore();

    // Out-of-view zero: push the split point off the appropriate end.
    if (zeroPx === null) {
      if (maxV !== -Infinity && maxV < 0) zeroPx = opt.left + opt.lineWidth + 1;
      else if (minV !== Infinity && minV > 0) zeroPx = opt.left - 1;
      else zeroPx = null;
    }

    var lnStt = opt.left - 25;
    var lnEnd = opt.left + opt.lineWidth + 25;

    // Arrowheads must be fully inside the canvas or they get clipped. Keep
    // a margin at least as large as the head, and make the head shorter
    // than the whole arrow so the barbs never overrun the tip.
    var HEAD_LEN = 22;
    var HEAD_HT = 20;
    var SHAFT = 34;
    var margin = HEAD_LEN + 2;

    lnStt = Math.max(lnStt, margin);
    lnEnd = Math.min(lnEnd, opt.width - margin);

    // Where the solid pipe stops and the arrowhead takes over.
    var pipeStt = lnStt + SHAFT - 8;
    var pipeEnd = lnEnd - SHAFT + 8;

    ctx.save();
    ctx.lineWidth = 2;

    if (zeroPx !== null && zeroPx > lnStt && pipeEnd > pipeStt) {
      ctx.strokeStyle = THEME.negative;
      ctx.drawPipe(pipeStt, baseline, Math.min(zeroPx, pipeEnd), baseline, THEME.negative);
    }

    if (zeroPx === null || zeroPx < lnEnd) {
      ctx.strokeStyle = THEME.positive;
      ctx.drawPipe(
        Math.max(zeroPx === null ? pipeStt : zeroPx, pipeStt),
        baseline,
        pipeEnd,
        baseline,
        THEME.positive
      );
    }

    // End caps: anchored at the arrow's tip, shaft pointing inward.
    ctx.fillStyle = zeroPx !== null && zeroPx > lnStt ? THEME.negative : THEME.positive;
    ctx.beginPath();
    ctx.drawArrow(lnStt, baseline, SHAFT, 3, HEAD_LEN, HEAD_HT, Math.PI);
    ctx.fill();

    ctx.fillStyle = zeroPx !== null && zeroPx > lnEnd ? THEME.negative : THEME.positive;
    ctx.beginPath();
    ctx.drawArrow(lnEnd, baseline, SHAFT, 3, HEAD_LEN, HEAD_HT, 0);
    ctx.fill();

    ctx.restore();

    this.drawMarks(ctx, baseline);

    if (this.hoverX !== null && this.pointerDown) {
      ctx.save();
      ctx.strokeStyle = "rgba(17,24,39,0.35)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.hoverX, baseline - 34);
      ctx.lineTo(this.hoverX, baseline + 26);
      ctx.stroke();
      ctx.restore();
    }
  };

  /**
   * Draw value markers (e.g. pi) above the tick labels.
   *
   * The marker occupies its own band starting above the label row, so it
   * never lands on top of a tick label the way a shorter stem did.
   */
  Numberline.prototype.drawMarks = function (ctx, baseline) {
    if (!this.marksQ || !this.marks.length) return;

    // Derive the marker band from the space actually above the line, so it
    // uses the available headroom on tall canvases without clipping on
    // short ones.
    var headroom = baseline - 8;
    var stemBottom = baseline - 6;
    var stemTop = Math.max(12, Math.min(baseline - 60, headroom - 22));

    ctx.save();
    ctx.fillStyle = "#b45309";
    ctx.strokeStyle = "#b45309";
    ctx.font = "700 15px ui-sans-serif, system-ui, Arial";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    for (var i = 0; i < this.marks.length; i++) {
      var mark = this.marks[i];
      var rel = this.coords.num2Rel(mark.num);

      if (rel > 0.001 && rel < 0.999) {
        var xp = this.opt.left + rel * this.opt.lineWidth;

        // Connector stem.
        ctx.beginPath();
        ctx.moveTo(xp, stemBottom);
        ctx.lineTo(xp, stemTop + 10);
        ctx.stroke();

        // Arrowhead pointing down at the value on the line.
        ctx.beginPath();
        ctx.drawArrow(xp, stemBottom, 14, 2, 12, 8, (3 * Math.PI) / 2);
        ctx.fill();

        // Label plate: a subtle rounded chip so the marker stays legible
        // where it crosses a tick label, without a hard white box.
        var text = mark.label;
        var tw = ctx.measureText(text).width;
        var ty = stemTop - 2;

        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.78)";
        ctx.strokeStyle = "rgba(180,83,9,0.30)";
        ctx.lineWidth = 1;
        ctx.beginPath();

        if (ctx.roundRect) {
          ctx.roundRect(xp - tw / 2 - 6, ty - 11, tw + 12, 22, 7);
        } else {
          ctx.rect(xp - tw / 2 - 6, ty - 11, tw + 12, 22);
        }

        ctx.fill();
        ctx.stroke();
        ctx.restore();

        ctx.fillText(text, xp, ty);
      }
    }

    ctx.restore();
  };

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  var instances = typeof WeakMap === "function" ? new WeakMap() : null;

  /**
   * Attach a number line to a canvas.
   *
   * `canvas` may be an element or a CSS selector; omitted entirely it uses
   * the first <canvas> in the document. Calling this again for the same
   * canvas returns the existing instance, so repeated calls are cheap and
   * safe. Returns the Numberline, or null if no canvas was found.
   */
  function numberzoomMain(canvas, options) {
    var el;

    if (!canvas) {
      el = document.querySelector("canvas");
    } else if (typeof canvas === "string") {
      el = document.querySelector(canvas);
    } else if (canvas.nodeType === 1) {
      el = canvas;
    } else {
      return null;
    }

    if (!el || typeof el.getContext !== "function") return null;

    if (instances && instances.has(el)) return instances.get(el);

    var instance = new Numberline(el, options);

    // Wrap destroy so a torn-down canvas can be re-initialised later
    // instead of handing back a dead instance forever.
    var originalDestroy = instance.destroy.bind(instance);

    instance.destroy = function () {
      originalDestroy();
      if (instances) instances.delete(el);
    };

    if (instances) instances.set(el, instance);

    return instance;
  }

  Numberline.Num = Num;
  Numberline.Coords = Coords;
  Numberline.numberzoomMain = numberzoomMain;
  global.ZoomableNumberline = Numberline;
  global.numberzoomMain = numberzoomMain;
  global.Num = Num;
})(typeof window !== "undefined" ? window : this);
