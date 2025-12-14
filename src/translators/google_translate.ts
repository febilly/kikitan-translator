export default async function (text: string, source: string, target: string) {
    const res = await (await fetch(`https://faas-sgp1-18bc02ac.doserverless.co/api/v1/web/fn-db13f37d-c569-4f0a-b5aa-6eac364a55e3/default/translate?client=gtx&sl=${source}&tl=${target}&dt=t&dj=1&q=${encodeURIComponent(text)}`)).json()

    let final = ""

    final = unescape(res.sentences[0].trans)

    for (let i = 1; i < res.sentences.length; i++) {
        final += " " + unescape(res.sentences[i].trans)
    }

    return final
}  