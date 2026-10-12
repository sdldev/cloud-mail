import { connect } from 'cloudflare:sockets';
import { v4 as uuidv4 } from 'uuid';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SMTP_TIMEOUT = 30_000;

const smtpClient = {

	/**
	 * Kirim email lewat SMTP relay.
	 * config: { host, port, ssl, username, password }
	 *   ssl=true  -> implicit TLS (port 465)
	 *   ssl=false -> plaintext, upgrade STARTTLS bila server mendukung (port 587/2525)
	 * mail: { from, fromName, to: [addr], subject, text, html, attachments, replyMessageId }
	 *   attachments: hasil toResendAttachments() { filename, contentType, content(base64), contentId?, disposition? }
	 * return { data: { id: messageId } } ala Resend SDK; gagal melempar Error berisi balasan server.
	 */
	async sendMail(config, mail) {

		if (!config?.host || !config?.port) {
			throw new Error('SMTP host/port is not configured');
		}

		const fromDomain = this.getDomain(mail.from);
		const messageId = `<${uuidv4().replace(/-/g, '')}@${fromDomain}>`;

		let socket = await withTimeout(
			connect({ hostname: config.host, port: Number(config.port) }, {
				secureTransport: config.ssl ? 'on' : 'starttls',
				allowHalfOpen: false,
				expectedServerHostname: config.ssl ? config.host : undefined
			}),
			'SMTP connect timeout'
		);

		try {
			await this.expectReply(socket, 220, 'greeting');

			const ehloDomain = fromDomain || 'localhost';
			const ehloText = await this.command(socket, `EHLO ${ehloDomain}`, 250);

			if (!config.ssl && /[- ]STARTTLS/i.test(ehloText)) {
				await this.command(socket, 'STARTTLS', 220);
				socket = socket.startTls(config.host);
				await this.command(socket, `EHLO ${ehloDomain}`, 250);
			}

			if (config.username) {
				await this.command(socket, 'AUTH LOGIN', 334);
				await this.command(socket, toBase64(config.username), 334);
				await this.command(socket, toBase64(config.password || ''), 235);
			}

			await this.command(socket, `MAIL FROM:<${mail.from}>`, 250);

			for (const to of mail.to) {
				await this.command(socket, `RCPT TO:<${to}>`, [250, 251]);
			}

			await this.command(socket, 'DATA', 354);

			const raw = this.buildMime(mail, messageId);

			await withTimeout(this.write(socket, dotStuff(raw) + '\r\n.\r\n'), 'SMTP message send timeout');
			await this.expectReply(socket, 250, 'end of DATA');

			try {
				await this.command(socket, 'QUIT', 221);
			} catch (e) {
				// sebagian server menutup koneksi tanpa membalas QUIT
			}

			return { data: { id: messageId } };

		} finally {
			try { socket.close(); } catch (e) { }
		}
	},

	async command(socket, text, expected) {
		await withTimeout(this.write(socket, text + '\r\n'), 'SMTP write timeout');
		return await this.expectReply(socket, expected, text.split(' ')[0]);
	},

	async expectReply(socket, expected, stage) {
		const reader = socket.readable.getReader();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await withTimeout(reader.read(), `SMTP reply timeout (${stage})`);

				if (value) {
					buffer += decoder.decode(value, { stream: true });
				}

				if (buffer.endsWith('\r\n')) {
					const lines = buffer.split('\r\n').filter(line => line !== '');
					const last = lines[lines.length - 1] || '';

					if (/^\d{3}(\s|$)/.test(last)) {
						const code = Number(last.slice(0, 3));
						const text = lines.join(' | ');

						const expectedList = Array.isArray(expected) ? expected : [expected];

						if (!expectedList.includes(code)) {
							throw new Error(`SMTP ${code}: ${text}`);
						}

						return text;
					}
				}

				if (done) {
					throw new Error(`SMTP connection closed during ${stage}: ${buffer}`);
				}
			}
		} finally {
			reader.releaseLock();
		}
	},

	async write(socket, text) {
		const writer = socket.writable.getWriter();
		try {
			await writer.write(encoder.encode(text));
		} finally {
			writer.releaseLock();
		}
	},

	buildMime(mail, messageId) {
		const now = new Date();
		const date = `${WEEKDAYS[now.getUTCDay()]}, ${String(now.getUTCDate()).padStart(2, '0')} ` +
			`${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} ` +
			`${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')} +0000`;

		const lines = [
			`From: ${this.encodeAddress(mail.fromName, mail.from)}`,
			`To: ${mail.to.join(', ')}`,
			`Subject: ${this.encodeHeader(mail.subject || '')}`,
			`Date: ${date}`,
			`Message-ID: ${messageId}`,
			'MIME-Version: 1.0'
		];

		if (mail.replyMessageId) {
			lines.push(`In-Reply-To: ${mail.replyMessageId}`, `References: ${mail.replyMessageId}`);
		}

		const hasHtml = !!mail.html;
		const hasText = !!mail.text;
		const attachments = mail.attachments || [];

		if (attachments.length > 0) {
			const boundary = 'cm_mixed_' + uuidv4().replace(/-/g, '');
			lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');

			lines.push(`--${boundary}`);
			lines.push(...this.bodyPart(mail, hasText, hasHtml));
			lines.push('');

			for (const attachment of attachments) {
				lines.push(`--${boundary}`);
				lines.push(...this.attachmentPart(attachment));
				lines.push('');
			}

			lines.push(`--${boundary}--`);
			return lines.join('\r\n');
		}

		if (hasHtml && hasText) {
			const boundary = 'cm_alt_' + uuidv4().replace(/-/g, '');
			lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
			lines.push(`--${boundary}`);
			lines.push(...this.textContentPart('text/plain', mail.text));
			lines.push('');
			lines.push(`--${boundary}`);
			lines.push(...this.textContentPart('text/html', mail.html));
			lines.push('');
			lines.push(`--${boundary}--`);
			return lines.join('\r\n');
		}

		lines.push(...this.textContentPart('text/html', hasHtml ? mail.html : (mail.text || '')));
		return lines.join('\r\n');
	},

	bodyPart(mail, hasText, hasHtml) {
		if (!hasHtml) {
			return this.textContentPart('text/plain', mail.text || '');
		}

		if (!hasText) {
			return this.textContentPart('text/html', mail.html);
		}

		const boundary = 'cm_alt_' + uuidv4().replace(/-/g, '');
		return [
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			...this.textContentPart('text/plain', mail.text),
			'',
			`--${boundary}`,
			...this.textContentPart('text/html', mail.html),
			'',
			`--${boundary}--`
		];
	},

	textContentPart(type, content) {
		return [
			`Content-Type: ${type}; charset=UTF-8`,
			'Content-Transfer-Encoding: base64',
			'',
			wrapBase64(toBase64(content || ''))
		];
	},

	attachmentPart(attachment) {
		const contentType = attachment.contentType || 'application/octet-stream';
		const filename = this.encodeHeader(attachment.filename || 'attachment');
		const isInline = attachment.contentId || attachment.disposition === 'inline';
		const disposition = isInline ? 'inline' : 'attachment';
		const headerLines = [
			`Content-Type: ${contentType}; name="${filename}"`,
			'Content-Transfer-Encoding: base64',
			`Content-Disposition: ${disposition}; filename="${filename}"`
		];

		if (attachment.contentId) {
			headerLines.push(`Content-ID: <${attachment.contentId.replace(/^<|>$/g, '')}>`);
		}

		return [...headerLines, '', wrapBase64(attachment.content || '')];
	},

	encodeAddress(name, address) {
		if (!name) {
			return address;
		}
		return `${this.encodeHeader(name)} <${address}>`;
	},

	encodeHeader(value) {
		const text = String(value).replace(/[\r\n]+/g, ' ').trim();

		if (!/[^\x20-\x7e]/.test(text)) {
			return text;
		}

		const base64 = toBase64(text);
		const chunks = base64.match(/.{1,40}/g) || [''];
		return chunks.map(chunk => `=?UTF-8?B?${chunk}?=`).join('\r\n ');
	},

	getDomain(email) {
		return String(email).split('@')[1] || '';
	}

};

async function withTimeout(promise, message) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), SMTP_TIMEOUT);
		})
	]).finally(() => clearTimeout(timer));
}

function toBase64(text) {
	const bytes = encoder.encode(text);
	let binary = '';

	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}

	return btoa(binary);
}

function wrapBase64(base64) {
	const chunks = base64.match(/.{1,76}/g) || [''];
	return chunks.join('\r\n');
}

// RFC 5321 §4.5.2: baris yang diawali titik harus ditambah titik ekstra
function dotStuff(raw) {
	return raw.split('\r\n').map(line => line.startsWith('.') ? '.' + line : line).join('\r\n');
}

export default smtpClient;
