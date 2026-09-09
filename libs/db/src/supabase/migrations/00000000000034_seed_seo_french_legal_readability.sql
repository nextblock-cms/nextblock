-- Migration: 00000000000034_seed_seo_french_legal_readability.sql
-- Description: Optimize French legal pages (politique de confidentialité & conditions d'utilisation) readability to achieve 100/100 Page SEO score.
-- Safety: Forward-only, content-guarded updates that only apply to default seeded content.

DO $$
BEGIN
  -- Page 10: Politique de confidentialité FR (Block 92)
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Politique de confidentialité</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>
<p>NextBlock™ CMS (« nous ») respecte votre vie privée. Nous protégeons vos données personnelles selon la Loi 25 du Québec, la loi fédérale LPRPDE et les règles canadiennes anti-pourriel (LCAP).</p>

<h2>1. Responsable de la protection des données personnelles</h2>
<p>Notre responsable veille au respect des règles de confidentialité. Vous pouvez lui écrire à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>2. Renseignements que nous recueillons</h2>
<ul>
  <li><strong>Renseignements de compte</strong> &mdash; nom, adresse courriel et identifiants lors de l''inscription.</li>
  <li><strong>Données d''utilisation et d''appareil</strong> &mdash; recueillies uniquement avec votre consentement au moyen de outils web.</li>
  <li><strong>Communications</strong> &mdash; les messages que vous nous envoyez et vos préférences marketing.</li>
</ul>

<h2>3. Finalités et consentement</h2>
<p>Nous recueillons vos données pour des motifs clairs : faire fonctionner nos services, sécuriser les accès et vous répondre. Les outils d''analyse et de suivi ne s''activent qu''avec votre accord clair. Selon la Loi 25, les témoins optionnels restent coupés tant que vous ne les acceptez pas. Vous pouvez retirer votre accord en tout temps.</p>

<h2>4. Témoins et technologies de suivi</h2>
<p>Les témoins essentiels assurent le bon usage du site. Ils ne demandent aucun accord préalable. Les témoins d''analyse se chargent seulement après votre choix sur notre bandeau. Nous gardons votre choix en mémoire pour le respecter.</p>

<h2>5. Partage des données</h2>
<p>Nous ne vendons pas vos données personnelles. Nous ne les communiquons qu''à des fournisseurs qui nous aident à exploiter la plateforme, sous obligation de confidentialité, ou lorsque la loi l''exige.</p>

<h2>6. Conservation</h2>
<p>Nous ne conservons les données personnelles que le temps nécessaire aux fins décrites ou exigé par la loi, après quoi ils sont détruits ou anonymisés sans risque.</p>

<h2>7. Vos droits</h2>
<p>Vous avez le droit de lire, de corriger et de faire effacer vos données. Vous pouvez aussi retirer votre accord ou demander une copie de vos données. Pour exercer vos droits, écrivez à notre responsable à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>

<h2>8. Messages électroniques commerciaux (LCAP)</h2>
<p>Nous n''envoyons des messages électroniques commerciaux qu''avec votre consentement. Chaque message nous identifie et comporte un mécanisme de désabonnement fonctionnel que nous respectons rapidement.</p>

<h2>9. Mesures de sécurité</h2>
<p>Nous employons des mesures physiques, organisationnelles et technologiques appropriées &mdash; dont le chiffrement en transit et le contrôle des accès &mdash; pour protéger vos données.</p>

<h2>10. Logiciel libre</h2>
<p>NextBlock™ CMS est un logiciel libre sous licence AGPLv3. Si vous hébergez NextBlock vous-même, vous gérez votre propre serveur. Vous êtes responsable des données sur votre instance, et ce texte est un modèle que vous pouvez adapter.</p>

<h2>11. Modifications</h2>
<p>Nous pouvons mettre à jour cette politique. Les changements importants seront communiqués sur le site et la date de mise à jour sera révisée.</p>

<h2>12. Nous joindre</h2>
<p>Des questions ou des plaintes ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>. Vous pouvez aussi vous adresser à la Commission d''accès à l''information du Québec.</p>
'::text)),
         updated_at = now()
   WHERE id = 92
     AND page_id = 10
     AND content->>'html_content' LIKE '%Politique de confidentialité%';

  -- Page 12: Conditions d'utilisation FR (Block 94)
  UPDATE public.blocks
     SET content = jsonb_set(content, '{html_content}', to_jsonb('
<h1>Règles du service</h1>
<p><em>Dernière mise à jour : 4 juin 2026</em></p>

<h2>1. Acceptation des conditions</h2>
<p>En utilisant le CMS NextBlock™ et les services associés (les « Services »), vous acceptez ces règles du service. Si vous refusez ces règles, veuillez ne pas utiliser les Services.</p>

<h2>2. Logiciel libre et à code source ouvert</h2>
<p>NextBlock™ CMS est un logiciel libre et à code source ouvert distribué sous la <strong>licence publique générale GNU Affero, version 3 (AGPL-3.0)</strong> ou, à votre choix, toute version ultérieure. Vous êtes libre d''exécuter, d''étudier, de partager et de modifier le logiciel selon les termes de cette licence. Une copie de la licence est fournie avec le logiciel et est aussi disponible à <a href="https://www.gnu.org/licenses/agpl-3.0.html">gnu.org/licenses/agpl-3.0.html</a>.</p>
<p>Droit d''auteur © 2025 NextBlock™ CMS.</p>

<h2>3. Disponibilité du code source</h2>
<p>Conformément à l''article 13 de l''AGPL-3.0, si vous exploitez une version modifiée de NextBlock™ CMS et la rendez accessible à des utilisateurs sur un réseau, vous devez offrir clairement à ces utilisateurs l''accès au code source correspondant de votre version modifiée, gratuitement, par un moyen usuel de copie de logiciels.</p>

<h2>4. Marques de commerce</h2>
<p>L''AGPL-3.0 accorde de larges droits sur le code source du logiciel, mais <strong>n''accorde aucun droit</strong> sur nos noms commerciaux, marques de commerce ou marques de service. « NextBlock™ », le nom NextBlock™ CMS et les logos associés demeurent notre propriété et ne peuvent être utilisés d''une manière laissant entendre une approbation ou une affiliation sans notre autorisation écrite préalable.</p>

<h2>5. Comptes et utilisation acceptable</h2>
<p>Si vous créez un compte, vous êtes responsable de la protection de vos identifiants et de toute activité effectuée à partir de votre compte, et vous vous engagez à nous aviser rapidement de toute utilisation non autorisée. Vous vous engagez à ne pas détourner les Services, notamment en tentant de les perturber, d''y accéder sans autorisation ou de les utiliser à des fins illégales.</p>

<h2>6. Absence de garantie</h2>
<p>Selon l''article 15 de l''AGPL-3.0, le logiciel est fourni « tel quel », sans garantie d''aucune sorte, expresse ou tacite. Cela inclut les garanties de vente ou d''usage pour un besoin précis. Vous prenez sur vous les risques liés au bon emploi du logiciel.</p>

<h2>7. Limitation de devoir</h2>
<p>Comme l''énonce l''article 16 de l''AGPL-3.0, et dans toute la mesure permise par la loi applicable, en aucun cas un titulaire de droits d''auteur ou toute autre partie qui modifie ou transmet le logiciel ne saurait être tenu responsable envers vous de dommages, y compris tout dommage général, spécial, accessoire ou consécutif liés à l''usage du code.</p>

<h2>8. Droit applicable</h2>
<p>Ces conditions suivent les lois de la province de Québec et les lois du Canada applicables. Rien ici ne réduit vos droits stricts de consommateur selon ces lois.</p>

<h2>9. Modifications</h2>
<p>Nous pouvons réviser ces conditions de temps à autre. Les changements importants seront communiqués au moyen des Services, et l''utilisation continue des Services après leur entrée en vigueur vaut acceptation.</p>

<h2>10. Nous joindre</h2>
<p>Des questions sur ces conditions ? Contactez NextBlock™ CMS à <a href="mailto:{{privacy_email}}">{{privacy_email}}</a>.</p>
'::text)),
         updated_at = now()
   WHERE id = 94
     AND page_id = 12
     AND content->>'html_content' LIKE '%Conditions d''utilisation%';

END $$;
